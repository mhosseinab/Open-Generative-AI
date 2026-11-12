// Deployment overlay: generated/uploaded media and its catalog live in private Hetzner S3.
// The historical module and URL names remain compatible with existing saved video links.
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const https = require('node:https');
const { isIP } = require('node:net');
const { Readable, Transform } = require('node:stream');

const completed = new Set(['completed', 'succeeded', 'success']);
const pendingUploads = new Map();
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const mediaTypes = new Set(['image', 'video', 'audio', 'file', 'media', 'image_url', 'video_url', 'audio_url', 'file_url', 'media_url']);
const mediaFields = new Set(['url', 'uri', 'src', 'image_url', 'video_url', 'audio_url', 'file_url', 'media_url', 'preview_url', 'thumbnail_url', 'download_url', 'signed_url', 'poster_url', 'image', 'video', 'audio', 'images', 'videos', 'audios', 'outputs', 'media', 'files']);
const containerFields = new Set(['output', 'outputs', 'result', 'results', 'data', 'assets', 'attachments', 'nodes', 'messages', 'events', 'payload', 'content', 'history', 'conversation', 'conversation_history', 'message_history', 'chat_history', 'tool_result', 'asset', 'canvas_state', 'workflow_definition', 'files', 'images', 'videos', 'audios', 'media']);
const structuredFields = new Set(['canvas_state', 'workflow_definition']);
const extensionTypes = {
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', opus: 'audio/ogg',
};

function config(env = process.env) {
    if (!env.VIDEO_STORAGE_BUCKET) return null;
    for (const name of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SIGNING_SECRET']) {
        if (!env[`VIDEO_STORAGE_${name}`]) throw new Error('Media storage is not fully configured');
    }
    if (env.VIDEO_STORAGE_SIGNING_SECRET.length < 32) throw new Error('Media storage signing secret is too short');
    const endpoint = new URL(env.VIDEO_STORAGE_ENDPOINT);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid media storage endpoint');
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
        throw new Error('Media source must be a public HTTPS hostname');
    }
    const addresses = await resolve(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
        throw new Error('Media source resolves to a non-public address');
    }
    return { url, address: addresses[0] };
}

function mediaContentType(raw, url) {
    const type = (raw || '').split(';')[0].trim().toLowerCase();
    if (/^(image|video|audio)\/[a-z0-9.+-]+$/.test(type)) return type;
    if (type === 'application/ogg') return 'audio/ogg';
    if (type === 'application/octet-stream' || type === 'binary/octet-stream' || !type) {
        const extension = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1].toLowerCase();
        return extensionTypes[extension] || null;
    }
    return null;
}

async function download(raw, redirects = 0, dependencies = {}) {
    if (redirects > 4) throw new Error('Too many media source redirects');
    const { url, address } = await publicTarget(raw, dependencies.resolve || lookup);
    const response = await new Promise((resolve, reject) => {
        const request = (dependencies.get || https.get)(url, {
            // Pin the validated DNS result, preventing rebinding at connect time.
            lookup: (_hostname, options, callback) => {
                if (options?.all) callback(null, [address]);
                else callback(null, address.address, address.family);
            },
            headers: { 'User-Agent': 'GenerativeAIStudio/1.0', Accept: 'image/*,video/*,audio/*,application/octet-stream;q=0.5', 'Accept-Encoding': 'identity' },
            signal: AbortSignal.timeout(5 * 60 * 1000),
        }, resolve);
        request.setTimeout(30_000, () => request.destroy(new Error('Media source timed out')));
        request.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location) throw new Error('Media redirect has no location');
        return download(new URL(response.headers.location, url).href, redirects + 1, dependencies);
    }
    if (response.statusCode !== 200) {
        response.destroy(); throw new Error('Media source download failed');
    }
    const type = mediaContentType(response.headers['content-type'], url.href);
    if (!type) { response.destroy(); return null; }
    const length = Number(response.headers['content-length']);
    if (length > MAX_BYTES) { response.destroy(); throw new Error('Media exceeds the 2 GiB storage limit'); }
    let bytes = 0;
    const limited = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > MAX_BYTES ? new Error('Media exceeds the 2 GiB storage limit') : null, chunk);
        },
    });
    response.on('error', error => limited.destroy(error));
    limited.on('error', () => response.destroy());
    limited.on('close', () => response.destroy());
    response.pipe(limited);
    return { body: limited, type };
}

function capability(key, secret) {
    return createHmac('sha256', secret).update(key).digest('hex');
}

function storedUrl(key, secret, contentType) {
    const kind = String(contentType || '').split('/')[0];
    const hint = ['image', 'video', 'audio'].includes(kind) ? `&type=${kind}` : '';
    return `/api/stored-videos/${key}?token=${capability(key, secret)}${hint}`;
}

function validCapability(key, token, secret) {
    if (!/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(token || '')) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(capability(key, secret)));
}

function ownerPrefix(apiKey, secret) {
    return createHmac('sha256', secret).update(apiKey).digest('hex');
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function normalizedSource(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:') return null;
        return url.origin + url.pathname;
    } catch { return null; }
}
function manifestKey(owner, requestId) { return `history/${owner}/${hash(requestId)}.json`; }
function deletionKey(owner, requestId) { return `history/${owner}/deleted-${hash(requestId)}.json`; }
function linkKey(owner, source) { return `links/${owner}/${hash(source)}.json`; }
function notFound(error) { return error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey'; }

async function s3Store(settings) {
    const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const { Upload } = await import('@aws-sdk/lib-storage');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = new S3Client({
        endpoint: settings.endpoint, region: settings.region, forcePathStyle: true,
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
    const base = { Bucket: settings.bucket };
    return {
        async exists(key) {
            try { await client.send(new HeadObjectCommand({ ...base, Key: key })); return true; }
            catch (error) { if (notFound(error)) return false; throw error; }
        },
        async put(key, media) {
            const upload = new Upload({ client, params: {
                ...base, Key: key, Body: media.body, ContentType: media.type, ContentDisposition: 'inline',
            }, queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false });
            await upload.done();
        },
        async get(key, { method = 'GET', range } = {}) {
            const Command = method === 'HEAD' ? HeadObjectCommand : GetObjectCommand;
            return client.send(new Command({ ...base, Key: key, ...(range ? { Range: range } : {}) }));
        },
        async signedGet(key, method = 'GET', expiresIn = 900) {
            const Command = method === 'HEAD' ? HeadObjectCommand : GetObjectCommand;
            return getSignedUrl(client, new Command({ ...base, Key: key }), { expiresIn });
        },
        async getJson(key) {
            try {
                const response = await client.send(new GetObjectCommand({ ...base, Key: key }));
                if (response.ContentLength > MAX_JSON_BYTES) { response.Body?.destroy?.(); throw new Error('Media manifest is too large'); }
                const text = await response.Body.transformToString();
                if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('Media manifest is too large');
                return JSON.parse(text);
            } catch (error) { if (notFound(error)) return null; throw error; }
        },
        async putJson(key, data) {
            const body = JSON.stringify(data);
            if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new Error('Media manifest is too large');
            await client.send(new PutObjectCommand({ ...base, Key: key, Body: body, ContentType: 'application/json', CacheControl: 'private, no-store' }));
        },
        async list(prefix, { limit = 1000, cursor } = {}) {
            const result = await client.send(new ListObjectsV2Command({ ...base, Prefix: prefix, MaxKeys: limit, ...(cursor ? { ContinuationToken: cursor } : {}) }));
            return { keys: (result.Contents || []).map(item => item.Key).filter(Boolean), next_cursor: result.NextContinuationToken || null };
        },
    };
}

async function context(options) {
    const settings = config(options.env || process.env);
    if (!options.apiKey || !settings) return null;
    return { settings, owner: ownerPrefix(options.apiKey, settings.secret), store: options.store || await s3Store(settings) };
}

const embeddedUrlPattern = /https:\/\/[^\s<>"'`)\]]+/g;

async function rewriteEmbeddedUrls(text, replace) {
    const replacements = new Map();
    for (const match of text.matchAll(embeddedUrlPattern)) {
        const raw = match[0];
        const url = raw.replace(/[.,;!]+$/, '');
        if (!replacements.has(raw)) replacements.set(raw, await replace(url, match.index) + raw.slice(url.length));
    }
    return text.replace(embeddedUrlPattern, raw => replacements.get(raw));
}

async function mapMediaFields(value, archive, mediaValue = false, descend = false) {
    if (typeof value === 'string') return mediaValue && /^https:\/\//i.test(value) ? archive(value) : value;
    if (Array.isArray(value)) return Promise.all(value.map(item => mapMediaFields(item, archive, mediaValue, descend)));
    if (!value || typeof value !== 'object') return value;
    const result = { ...value };
    const typedMedia = mediaTypes.has(String(value.type || value.kind || '').toLowerCase());
    for (const [name, child] of Object.entries(value)) {
        if (name === 'metadata') continue;
        if (structuredFields.has(name) && typeof child === 'string') {
            let parsed;
            try { parsed = JSON.parse(child); } catch { continue; }
            result[name] = JSON.stringify(await mapMediaFields(parsed, archive, false, true));
        }
        else if (['content', 'text', 'markdown'].includes(name) && typeof child === 'string') {
            result[name] = await rewriteEmbeddedUrls(child, async (url, index) => {
                const prefix = child.slice(0, index);
                const explicitImage = /!\[[^\]]*\]\($/.test(prefix) || /<img\b[^>]*\bsrc=["']$/i.test(prefix);
                return mediaContentType('', url) || explicitImage ? archive(url) : url;
            });
        }
        else if (name === 'value' && typedMedia) result[name] = await mapMediaFields(child, archive, true, true);
        else if (mediaFields.has(name)) result[name] = await mapMediaFields(child, archive, true, true);
        else if (containerFields.has(name)) result[name] = await mapMediaFields(child, archive, ['output', 'assets', 'attachments', 'files'].includes(name), true);
        else if (descend && child && typeof child === 'object' && name !== 'value') result[name] = await mapMediaFields(child, archive, false, true);
    }
    return result;
}

async function archiveMediaFields(data, options = {}) {
    if (!options.apiKey || !options.requestId) return data;
    const ctx = options.context || await context(options);
    if (!ctx) return data;
    const { settings, owner, store } = ctx;
    const downloadMedia = options.downloadMedia || options.downloadVideo || download;
    async function archiveUrl(url) {
        // Already-stored absolute app links are not fetched through Access again.
        const parsed = new URL(url);
        if (/^\/api\/(?:stored-videos|stored-media)\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(parsed.pathname) && validCapability(parsed.pathname.split('/').slice(-2).join('/'), parsed.searchParams.get('token'), settings.secret)) return parsed.pathname + parsed.search;
        // AI providers may echo our temporary signed S3 input URL. Reuse its
        // existing object instead of persisting another copy or exposing the signature.
        const bucketPrefix = `/${encodeURIComponent(settings.bucket)}/`;
        if (parsed.origin === settings.endpoint && parsed.pathname.startsWith(bucketPrefix)) {
            const existingKey = decodeURIComponent(parsed.pathname.slice(bucketPrefix.length));
            if (!new RegExp(`^${owner}/[a-f0-9]{64}$`).test(existingKey)) throw new Error('Invalid stored media owner or object key');
            const metadata = store.get ? await store.get(existingKey, { method: 'HEAD' }) : null;
            if (!metadata && !await store.exists(existingKey)) throw new Error('Stored media object not found');
            const canonical = storedUrl(existingKey, settings.secret, metadata?.ContentType);
            if (store.putJson) await store.putJson(linkKey(owner, normalizedSource(url)), { source: normalizedSource(url), url: canonical });
            return canonical;
        }
        const source = normalizedSource(url);
        const key = `${owner}/${hash(options.requestId + ':' + source)}`;
        const pendingKey = `source:${owner}:${hash(source)}`;
        if (!pendingUploads.has(pendingKey)) {
            pendingUploads.set(pendingKey, (async () => {
                const prior = store.getJson ? await store.getJson(linkKey(owner, source)) : null;
                if (prior?.source === source && typeof prior.url === 'string') {
                    const reference = new URL(prior.url, 'https://stored.invalid');
                    const priorKey = reference.pathname.split('/').slice(-2).join('/');
                    if (reference.origin === 'https://stored.invalid' && /^\/api\/(?:stored-videos|stored-media)\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(reference.pathname) &&
                        priorKey.startsWith(owner + '/') && validCapability(priorKey, reference.searchParams.get('token'), settings.secret) && await store.exists(priorKey)) {
                        return prior.url;
                    }
                }
                let contentType = mediaContentType('', url);
                if (!await store.exists(key)) {
                    const media = await downloadMedia(url);
                    if (!media) throw new Error('Output is not supported image, video, or audio media');
                    try { await store.put(key, media); }
                    catch (error) { media.body.destroy?.(); throw error; }
                    contentType = media.type;
                } else if (store.get) {
                    contentType = (await store.get(key, { method: 'HEAD' })).ContentType || contentType;
                }
                const durableUrl = storedUrl(key, settings.secret, contentType);
                if (store.putJson) await store.putJson(linkKey(owner, source), { source, url: durableUrl });
                return durableUrl;
            })().finally(() => pendingUploads.delete(pendingKey)));
        }
        return pendingUploads.get(pendingKey);
    }
    return mapMediaFields(data, archiveUrl);
}

async function storeUploadedMedia(file, options = {}) {
    if (!options.apiKey || !options.requestId) throw new Error('Upload identity is required');
    const ctx = await context(options);
    if (!ctx) throw new Error('Media storage is not configured');
    if (!file || typeof file.stream !== 'function' || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_BYTES) {
        throw new Error('Upload must contain media no larger than 2 GiB');
    }
    const declaredType = String(file.type || '').toLowerCase();
    const extension = /\.([a-z0-9]+)$/i.exec(file.name || '')?.[1].toLowerCase();
    const blocked = new Set(['html', 'htm', 'svg', 'js', 'mjs', 'cjs', 'exe', 'bat', 'cmd', 'ps1', 'sh', 'php']);
    const type = mediaContentType(declaredType, `https://upload.invalid/${encodeURIComponent(file.name || '')}`);
    if (!type || type === 'image/svg+xml' || blocked.has(extension)) throw new Error('Unsupported upload file type');
    const key = `${ctx.owner}/${hash('upload:' + options.requestId)}`;
    let bytes = 0;
    const source = Readable.fromWeb(file.stream());
    const limited = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_BYTES ? new Error('Upload exceeds the 2 GiB storage limit') : null, chunk);
    } });
    source.on('error', error => limited.destroy(error));
    limited.on('error', () => source.destroy());
    limited.on('close', () => source.destroy());
    source.pipe(limited);
    try { await ctx.store.put(key, { body: limited, type }); }
    catch (error) { limited.destroy(); throw error; }
    return storedUrl(key, ctx.settings.secret, type);
}

function historyItem(data, requestId, previous, supplied) {
    const prior = previous || {};
    const extra = supplied || {};
    const createdAt = extra.created_at || prior.created_at || data.created_at || new Date().toISOString();
    return {
        request_id: requestId, status: data.status, created_at: createdAt,
        category: extra.category || prior.category || data.category || '',
        model: extra.model || prior.model || data.model || '',
        ...(extra.prompt || prior.prompt ? { prompt: extra.prompt || prior.prompt } : {}),
        output: data,
    };
}

async function archivePredictionResult(data, options = {}) {
    if (!options.apiKey || !options.requestId || !completed.has(String(data?.status).toLowerCase())) return data;
    const ctx = await context(options);
    if (!ctx) return data;
    if (await deletedInContext(options.requestId, ctx)) return deletedResult(options.requestId);
    const result = await archiveMediaFields(data, { ...options, context: ctx });
    if (await deletedInContext(options.requestId, ctx)) return deletedResult(options.requestId);
    if (ctx.store.putJson) {
        const key = manifestKey(ctx.owner, options.requestId);
        const previous = ctx.store.getJson ? await ctx.store.getJson(key) : null;
        await ctx.store.putJson(key, historyItem(result, options.requestId, previous, options.historyItem));
    }
    return result;
}

async function getArchivedResult(requestId, options = {}) {
    const ctx = await context(options);
    if (!ctx || !ctx.store.getJson) return null;
    if (await deletedInContext(requestId, ctx)) return null;
    const manifest = await ctx.store.getJson(manifestKey(ctx.owner, requestId));
    return manifest?.output || null;
}

async function archiveHistory(data, options = {}) {
    if (!Array.isArray(data?.items)) return data;
    const ctx = await context(options);
    if (!ctx) return data;
    const items = [];
    for (const item of data.items) {
        const requestId = item.request_id || item.id;
        if (!requestId || !completed.has(String(item.status).toLowerCase())) { items.push(item); continue; }
        const raw = item.output && typeof item.output === 'object' && !Array.isArray(item.output) ? item.output : { outputs: item.output };
        const archived = await archivePredictionResult({ ...raw, status: raw.status || item.status }, { ...options, requestId, store: ctx.store, historyItem: item });
        if (archived.status !== 'deleted') items.push({ ...item, output: archived });
    }
    return { ...data, items };
}

function deletedResult(requestId) { return { request_id: requestId, status: 'deleted', outputs: [] }; }
async function deletedInContext(requestId, ctx) {
    return Boolean(ctx.store.getJson && (await ctx.store.getJson(deletionKey(ctx.owner, requestId)))?.deleted);
}
async function isArchivedResultDeleted(requestId, options = {}) {
    const ctx = await context(options);
    return ctx ? deletedInContext(requestId, ctx) : false;
}
async function deleteArchivedResult(requestId, options = {}) {
    const ctx = await context(options);
    if (!ctx || !ctx.store.putJson) throw new Error('Media storage is not configured');
    // Keep deletion separate from the result object: an in-flight result write
    // cannot overwrite this marker and resurrect the deleted history entry.
    await ctx.store.putJson(deletionKey(ctx.owner, requestId), { request_id: requestId, deleted: true, created_at: new Date().toISOString() });
}
function visibleHistory(items) {
    const removed = new Set(items.filter(item => item.deleted).map(item => item.request_id));
    return items.filter(item => !item.deleted && !removed.has(item.request_id));
}

async function collectJson(store, prefix) {
    if (!store.list || !store.getJson) return [];
    const values = []; let cursor;
    do {
        const page = await store.list(prefix, { limit: 1000, cursor });
        // Bound concurrent object reads instead of opening one socket per saved item.
        for (let offset = 0; offset < page.keys.length; offset += 8) {
            const batch = await Promise.all(page.keys.slice(offset, offset + 8).map(key => store.getJson(key)));
            values.push(...batch.filter(Boolean));
        }
        cursor = page.next_cursor;
    } while (cursor);
    return values;
}

function sortHistory(items) {
    return items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || a.request_id.localeCompare(b.request_id));
}

async function listArchivedHistory(options = {}) {
    const ctx = await context(options);
    if (!ctx) return { items: [], next_cursor: null };
    const items = sortHistory(visibleHistory(await collectJson(ctx.store, `history/${ctx.owner}/`)));
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 50)));
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid archive cursor');
    return { items: items.slice(offset, offset + limit), next_cursor: offset + limit < items.length ? String(offset + limit) : null };
}

async function getMediaCatalog(options = {}) {
    const ctx = await context(options);
    if (!ctx) return { links: {}, items: [] };
    const [mappings, items] = await Promise.all([
        collectJson(ctx.store, `links/${ctx.owner}/`), collectJson(ctx.store, `history/${ctx.owner}/`),
    ]);
    return { links: Object.fromEntries(mappings.map(item => [item.source, item.url])), items: sortHistory(visibleHistory(items)) };
}

async function rewriteArchivedLinks(data, options = {}) {
    const catalog = options.catalog || await getMediaCatalog(options);
    async function rewrite(value, field) {
        if (typeof value === 'string' && structuredFields.has(field)) {
            try { return JSON.stringify(await rewrite(JSON.parse(value))); } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
            }
        }
        if (typeof value === 'string') {
            const exact = catalog.links[normalizedSource(value)];
            if (exact) return exact;
            return rewriteEmbeddedUrls(value, async url => catalog.links[normalizedSource(url)] || url);
        }
        if (Array.isArray(value)) return Promise.all(value.map(child => rewrite(child)));
        if (value && typeof value === 'object') {
            const result = {};
            for (const [key, child] of Object.entries(value)) result[key] = await rewrite(child, key);
            return result;
        }
        return value;
    }
    return rewrite(data);
}

module.exports = {
    archivePredictionResult, archiveMediaFields, storeUploadedMedia, archiveHistory, getArchivedResult, deleteArchivedResult, isArchivedResultDeleted, listArchivedHistory, getMediaCatalog, rewriteArchivedLinks,
    capability, config, download, mediaContentType, normalizedSource, publicAddress, publicTarget, s3Store, storedUrl, validCapability,
};
