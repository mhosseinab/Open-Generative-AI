// Deployment overlay: completed cloud-generated videos are retained in private Hetzner S3.
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const https = require('node:https');
const { isIP } = require('node:net');
const { Transform } = require('node:stream');

const completed = new Set(['completed', 'succeeded', 'success']);
const pendingUploads = new Map();
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

function config(env = process.env) {
    if (!env.VIDEO_STORAGE_BUCKET) return null;
    for (const name of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SIGNING_SECRET']) {
        if (!env[`VIDEO_STORAGE_${name}`]) throw new Error('Video storage is not fully configured');
    }
    if (env.VIDEO_STORAGE_SIGNING_SECRET.length < 32) throw new Error('Video storage signing secret is too short');
    const endpoint = new URL(env.VIDEO_STORAGE_ENDPOINT);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid video storage endpoint');
    return {
        endpoint: endpoint.origin, region: env.VIDEO_STORAGE_REGION, bucket: env.VIDEO_STORAGE_BUCKET,
        accessKeyId: env.VIDEO_STORAGE_ACCESS_KEY_ID, secretAccessKey: env.VIDEO_STORAGE_SECRET_ACCESS_KEY,
        secret: env.VIDEO_STORAGE_SIGNING_SECRET,
    };
}

function publicAddress(address) {
    if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
    if (isIP(address) !== 4) return false;
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)));
}

async function publicTarget(raw, resolve = lookup) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname === 'localhost') {
        throw new Error('Video source must be a public HTTPS hostname');
    }
    const addresses = await resolve(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
        throw new Error('Video source resolves to a non-public address');
    }
    return { url, address: addresses[0] };
}

async function download(raw, redirects = 0) {
    if (redirects > 4) throw new Error('Too many video source redirects');
    const { url, address } = await publicTarget(raw);
    const response = await new Promise((resolve, reject) => {
        const request = https.get(url, {
            // Pin the validated DNS result, preventing a second lookup/rebinding at connect time.
            lookup: (_hostname, options, callback) => {
                if (options?.all) callback(null, [address]);
                else callback(null, address.address, address.family);
            },
            headers: { Accept: 'video/*,application/octet-stream;q=0.5', 'Accept-Encoding': 'identity' },
            signal: AbortSignal.timeout(5 * 60 * 1000),
        }, resolve);
        request.setTimeout(30_000, () => request.destroy(new Error('Video source timed out')));
        request.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location) throw new Error('Video redirect has no location');
        return download(new URL(response.headers.location, url).href, redirects + 1);
    }
    if (response.statusCode !== 200) {
        response.destroy(); throw new Error('Video source download failed');
    }
    const type = (response.headers['content-type'] || '').split(';')[0].toLowerCase();
    const video = type.startsWith('video/') || (type === 'application/octet-stream' && /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(url.href));
    if (!video) { response.destroy(); return null; }
    const length = Number(response.headers['content-length']);
    if (length > MAX_BYTES) { response.destroy(); throw new Error('Generated video exceeds the 2 GiB storage limit'); }
    let bytes = 0;
    const limited = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > MAX_BYTES ? new Error('Generated video exceeds the 2 GiB storage limit') : null, chunk);
        },
    });
    response.on('error', error => limited.destroy(error));
    limited.on('error', () => response.destroy());
    response.pipe(limited);
    return { body: limited, type: type.startsWith('video/') ? type : 'video/mp4' };
}

function capability(key, secret) {
    return createHmac('sha256', secret).update(key).digest('hex');
}

function storedUrl(key, secret) {
    return `/api/stored-videos/${key}?token=${capability(key, secret)}`;
}

function validCapability(key, token, secret) {
    if (!/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(token || '')) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(capability(key, secret)));
}

async function s3Store(settings) {
    const { S3Client, HeadObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { Upload } = await import('@aws-sdk/lib-storage');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = new S3Client({
        endpoint: settings.endpoint, region: settings.region, forcePathStyle: true,
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return {
        async exists(key) {
            try { await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key })); return true; }
            catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; }
        },
        async put(key, video) {
            const upload = new Upload({ client, params: {
                Bucket: settings.bucket, Key: key, Body: video.body, ContentType: video.type,
                ContentDisposition: 'inline',
            }, queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false });
            await upload.done();
        },
        async signedGet(key, method = 'GET') {
            const Command = method === 'HEAD' ? HeadObjectCommand : GetObjectCommand;
            return getSignedUrl(client, new Command({ Bucket: settings.bucket, Key: key }), { expiresIn: 900 });
        },
    };
}

async function archivePredictionResult(data, { apiKey, requestId, env = process.env, store, downloadVideo = download } = {}) {
    if (!apiKey || !requestId || !completed.has(String(data?.status).toLowerCase())) return data;
    const settings = config(env);
    if (!settings) return data;
    store ||= await s3Store(settings);
    const owner = createHmac('sha256', settings.secret).update(apiKey).digest('hex');
    async function archiveUrl(url, position) {
        if (!/^https:\/\//i.test(url) || /\.(png|jpe?g|gif|webp|avif|svg|mp3|wav|ogg|flac|aac|m4a)(?:$|\?)/i.test(url)) return url;
        const source = new URL(url);
        const id = createHash('sha256').update(requestId + ':' + source.origin + source.pathname).digest('hex');
        const key = `${owner}/${id}`;
        if (await store.exists(key)) return storedUrl(key, settings.secret);
        if (!pendingUploads.has(key)) {
            pendingUploads.set(key, (async () => {
                const video = await downloadVideo(url);
                if (!video) return url;
                await store.put(key, video);
                return storedUrl(key, settings.secret);
            })().finally(() => pendingUploads.delete(key)));
        }
        return pendingUploads.get(key);
    }
    async function rewrite(value, position) {
        if (typeof value === 'string') return archiveUrl(value, position);
        if (Array.isArray(value)) return Promise.all(value.map((v, i) => rewrite(v, `${position}.${i}`)));
        if (value && typeof value === 'object') {
            const out = { ...value };
            for (const name of ['url', 'video_url', 'video', 'outputs', 'videos']) {
                if (name in out) out[name] = await rewrite(out[name], `${position}.${name}`);
            }
            return out;
        }
        return value;
    }
    const result = { ...data };
    for (const name of ['outputs', 'url', 'video_url', 'output', 'videos']) {
        if (name in result) result[name] = await rewrite(result[name], name);
    }
    return result;
}

module.exports = { archivePredictionResult, capability, config, download, publicAddress, publicTarget, s3Store, storedUrl, validCapability };
