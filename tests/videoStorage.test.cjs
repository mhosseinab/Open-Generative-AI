const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const storage = require('../src/lib/videoStorage.cjs');

const env = {
    VIDEO_STORAGE_ENDPOINT: 'https://hel1.your-objectstorage.com', VIDEO_STORAGE_REGION: 'hel1',
    VIDEO_STORAGE_BUCKET: 'test-media', VIDEO_STORAGE_ACCESS_KEY_ID: 'test', VIDEO_STORAGE_SECRET_ACCESS_KEY: 'test',
    VIDEO_STORAGE_SIGNING_SECRET: '0123456789abcdef0123456789abcdef',
};
function fixture() {
    const objects = new Map(), manifests = new Map(); let downloads = 0;
    const store = {
        exists: async key => objects.has(key),
        async put(key, media) {
            const chunks = []; for await (const chunk of media.body) chunks.push(chunk);
            objects.set(key, { bytes: Buffer.concat(chunks), type: media.type });
        },
        async get(key) { return { ContentType: objects.get(key).type }; },
        async getJson(key) { return manifests.has(key) ? structuredClone(manifests.get(key)) : null; },
        async putJson(key, data) { manifests.set(key, structuredClone(data)); },
        async list(prefix, { limit = 1000, cursor } = {}) {
            const keys = [...manifests.keys()].filter(key => key.startsWith(prefix)).sort();
            const offset = Number(cursor) || 0;
            return { keys: keys.slice(offset, offset + limit), next_cursor: offset + limit < keys.length ? String(offset + limit) : null };
        },
    };
    return {
        objects, manifests, get downloads() { return downloads; },
        options: { apiKey: 'owner-api-key', requestId: 'job-1', env, store,
            async downloadMedia(url) {
                downloads++;
                return { body: Readable.from([Buffer.from('media-bytes')]), type: storage.mediaContentType('', url) || 'image/png' };
            },
        },
    };
}
const stable = value => assert.match(value, /^\/api\/stored-videos\/[a-f0-9]{64}\/[a-f0-9]{64}\?token=[a-f0-9]{64}(?:&type=(?:image|video|audio))?$/);

test('pending and failed generations never request storage or download', async () => {
    for (const status of ['processing', 'queued', 'failed', 'error']) {
        const f = fixture(), result = { status, outputs: ['https://cdn.example/video.mp4'] };
        assert.strictEqual(await storage.archivePredictionResult(result, f.options), result);
        assert.equal(f.downloads, 0); assert.equal(f.objects.size, 0); assert.equal(f.manifests.size, 0);
    }
});

test('completed media is streamed to storage and receives a persistent signed capability', async () => {
    const f = fixture();
    const result = await storage.archivePredictionResult({ status: 'completed', outputs: ['https://cdn.example/video.mp4'] }, f.options);
    stable(result.outputs[0]); assert.match(result.outputs[0], /&type=video$/);
    assert.equal([...f.objects.values()][0].bytes.toString(), 'media-bytes');
    const url = new URL(result.outputs[0], 'https://studio.example');
    const key = url.pathname.replace('/api/stored-videos/', '');
    assert.equal(storage.validCapability(key, url.searchParams.get('token'), env.VIDEO_STORAGE_SIGNING_SECRET), true);
    assert.equal(storage.validCapability(key, '0'.repeat(64), env.VIDEO_STORAGE_SIGNING_SECRET), false);
});

test('all image/audio/video aliases are archived and nested metadata is left untouched', async () => {
    const f = fixture();
    const result = await storage.archivePredictionResult({
        status: 'completed', images: ['https://cdn.example/image.avif'], audio_url: 'https://cdn.example/music.wav',
        output: { video_url: 'https://cdn.example/video.mp4', thumbnail_url: 'https://cdn.example/thumb.png' },
        metadata: { url: 'https://documentation.example/model' },
    }, f.options);
    for (const url of [result.images[0], result.audio_url, result.output.video_url, result.output.thumbnail_url]) stable(url);
    assert.match(result.images[0], /&type=image$/); assert.match(result.audio_url, /&type=audio$/);
    assert.equal(result.metadata.url, 'https://documentation.example/model');
    assert.equal(f.objects.size, 4);
});

test('nested workflow typed-media values and agent attachments are archived, typed text links are not', async () => {
    const f = fixture();
    const raw = { status: 'processing', nodes: { nodeA: [{ status: 'completed', result: { outputs: [
        { type: 'image', value: 'https://cdn.example/image.png' },
        { type: 'text', value: 'https://documentation.example/page' },
    ] } }] }, history: [{ messages: [{ attachments: ['https://cdn.example/sound.mp3'] }] }], events: [{ payload: { asset: { signed_url: 'https://cdn.example/video.mp4' } } }] };
    const result = await storage.archiveMediaFields(raw, f.options);
    stable(result.nodes.nodeA[0].result.outputs[0].value);
    assert.equal(result.nodes.nodeA[0].result.outputs[1].value, 'https://documentation.example/page');
    stable(result.history[0].messages[0].attachments[0]);
    stable(result.events[0].payload.asset.signed_url);
    assert.equal(f.objects.size, 3);
    assert.equal([...f.manifests.keys()].some(key => key.startsWith('history/')), false);
});

test('repeated polls and changed source signatures do not duplicate objects or change canonical URLs', async () => {
    const f = fixture();
    const first = await storage.archivePredictionResult({ status: 'completed', outputs: ['https://cdn.example/image.png?signature=one'] }, f.options);
    const second = await storage.archivePredictionResult({ status: 'completed', outputs: ['https://cdn.example/image.png?signature=two'] }, f.options);
    assert.equal(f.objects.size, 1); assert.equal(f.downloads, 1);
    assert.equal(first.outputs[0], second.outputs[0]);
    const catalog = await storage.getMediaCatalog(f.options);
    assert.equal(catalog.links['https://cdn.example/image.png'], first.outputs[0]);
    assert.equal(Object.keys(catalog.links).some(key => key.includes('signature')), false);
});

test('duplicate result aliases and simultaneous polls share one upload', async () => {
    const f = fixture(), data = { status: 'completed', outputs: ['https://cdn.example/video.mp4'], url: 'https://cdn.example/video.mp4' };
    const results = await Promise.all([storage.archivePredictionResult(data, f.options), storage.archivePredictionResult(data, f.options)]);
    assert.equal(f.downloads, 1); assert.equal(f.objects.size, 1);
    assert.equal(results[0].outputs[0], results[0].url);
});

test('different owners cannot reuse each other’s capabilities or persisted catalogs', async () => {
    const a = fixture(), b = fixture(); b.options.apiKey = 'second-owner'; b.options.store = a.options.store;
    const data = { status: 'completed', outputs: ['https://cdn.example/video.mp4'] };
    const first = await storage.archivePredictionResult(data, a.options);
    assert.equal(await storage.getArchivedResult('job-1', b.options), null);
    assert.deepEqual(await storage.getMediaCatalog(b.options), { links: {}, items: [] });
    assert.notEqual(first.outputs[0], (await storage.archivePredictionResult(data, b.options)).outputs[0]);
});

test('missing auth or disabled storage leaves data unchanged for BYOK compatibility', async () => {
    const data = { status: 'completed', outputs: ['https://cdn.example/video.mp4'] };
    assert.strictEqual(await storage.archivePredictionResult(data, { ...fixture().options, apiKey: null }), data);
    assert.strictEqual(await storage.archivePredictionResult(data, { ...fixture().options, env: {} }), data);
});

test('media or manifest failures never return a successfully persisted result', async () => {
    const data = { status: 'completed', outputs: ['https://cdn.example/video.mp4'] };
    const a = fixture(); a.options.store.put = async () => { throw Error('storage unavailable'); };
    await assert.rejects(storage.archivePredictionResult(data, a.options), /storage unavailable/);
    assert.equal(await storage.getArchivedResult('job-1', a.options), null);
    const b = fixture(); b.options.store.putJson = async key => { if (key.startsWith('history/')) throw Error('manifest unavailable'); };
    await assert.rejects(storage.archivePredictionResult(data, b.options), /manifest unavailable/);
    const c = fixture(); c.options.downloadMedia = async () => null;
    await assert.rejects(storage.archivePredictionResult(data, c.options), /not supported/);
});

test('saved history and results remain available without provider access; source-link migration never downloads', async () => {
    const f = fixture();
    const archived = await storage.archivePredictionResult({ status: 'completed', outputs: ['https://cdn.example/image.png'] }, {
        ...f.options, historyItem: { created_at: '2026-10-01T10:00:00Z', model: 'image-model', category: 'Text to Image', prompt: 'stored prompt' },
    });
    f.options.downloadMedia = async () => { throw Error('provider has expired'); };
    assert.deepEqual(await storage.getArchivedResult('job-1', f.options), archived);
    const catalog = await storage.getMediaCatalog(f.options);
    assert.equal(catalog.items[0].model, 'image-model');
    assert.equal(catalog.items[0].prompt, 'stored prompt');
    assert.equal(catalog.items[0].output.outputs[0], archived.outputs[0]);
    const migrated = await storage.rewriteArchivedLinks({ oldUrl: 'https://cdn.example/image.png?expired=yes', unknown: 'https://other.example/file.png' }, f.options);
    assert.equal(migrated.oldUrl, archived.outputs[0]); assert.equal(migrated.unknown, 'https://other.example/file.png');
});

test('provider history is copied into a paginated catalog ordered by original creation time', async () => {
    const f = fixture();
    const history = { items: [
        { request_id: 'old', status: 'completed', created_at: '2026-10-01T00:00:00Z', model: 'old-model', output: { images: ['https://cdn.example/old.png'] } },
        { request_id: 'new', status: 'completed', created_at: '2026-11-01T00:00:00Z', output: { outputs: ['https://cdn.example/new.mp3'] } },
        { request_id: 'pending', status: 'processing' },
    ], next_cursor: 'provider-cursor' };
    const result = await storage.archiveHistory(history, f.options);
    stable(result.items[0].output.images[0]); assert.equal(result.next_cursor, 'provider-cursor');
    const first = await storage.listArchivedHistory({ ...f.options, limit: 1 });
    const second = await storage.listArchivedHistory({ ...f.options, limit: 1, cursor: first.next_cursor });
    assert.equal(first.items[0].request_id, 'new'); assert.equal(second.items[0].request_id, 'old');
    assert.equal(second.next_cursor, null);
    await assert.rejects(storage.listArchivedHistory({ ...f.options, cursor: '-1' }), /Invalid archive cursor/);
});

test('direct uploads stream into private storage without MuAPI and return typed durable links', async () => {
    const f = fixture();
    const file = new File([Buffer.from('upload-bytes')], 'reference.png', { type: 'image/png' });
    const url = await storage.storeUploadedMedia(file, { ...f.options, requestId: 'upload-1' });
    stable(url); assert.match(url, /&type=image$/);
    assert.equal([...f.objects.values()][0].bytes.toString(), 'upload-bytes');
    assert.equal(f.downloads, 0); assert.equal(f.manifests.size, 0);
    for (const bad of [new File(['x'], 'page.html', { type: 'text/html' }), new File(['x'], 'active.svg', { type: 'image/svg+xml' }), new File(['x'], 'attack.exe', { type: 'image/png' })]) {
        await assert.rejects(storage.storeUploadedMedia(bad, f.options), /Unsupported upload/);
    }
    await assert.rejects(storage.storeUploadedMedia({ size: 2 ** 32, stream() {} }, f.options), /2 GiB/);
});

test('existing saved URLs without type hints remain valid and are not redownloaded', async () => {
    const f = fixture();
    const key = 'a'.repeat(64) + '/' + 'b'.repeat(64);
    const old = storage.storedUrl(key, env.VIDEO_STORAGE_SIGNING_SECRET);
    assert.equal(old.includes('&type='), false);
    const result = await storage.archiveMediaFields({ url: 'https://studio.example' + old }, f.options);
    assert.equal(result.url, old); assert.equal(f.downloads, 0);
});

test('MIME detection accepts common media and rejects active HTML or unsupported blobs', () => {
    assert.equal(storage.mediaContentType('image/avif; charset=binary', 'https://cdn.example/asset'), 'image/avif');
    assert.equal(storage.mediaContentType('application/octet-stream', 'https://cdn.example/song.mp3?sig=x'), 'audio/mpeg');
    assert.equal(storage.mediaContentType('text/html', 'https://cdn.example/image.png'), null);
    assert.equal(storage.mediaContentType('application/octet-stream', 'https://cdn.example/unknown.bin'), null);
});

test('private, credentialed and non-HTTPS sources are refused', async () => {
    const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
    for (const url of ['http://cdn.example/video.mp4', 'https://127.0.0.1/video.mp4', 'https://[::1]/video.mp4', 'https://user:pass@cdn.example/v.mp4', 'https://cdn.example:8443/v.mp4']) await assert.rejects(storage.publicTarget(url, resolve));
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1']) {
        await assert.rejects(storage.publicTarget('https://cdn.example/v.mp4', async () => [{ address, family: address.includes(':') ? 6 : 4 }]));
    }
    assert.equal((await storage.publicTarget('https://cdn.example/v.mp4', resolve)).address.address, '93.184.216.34');
});

test('malformed paths and missing capabilities are refused', () => {
    for (const key of ['../secret', 'a/b', 'a'.repeat(64) + '/../' + 'b'.repeat(64)]) assert.equal(storage.validCapability(key, 'f'.repeat(64), env.VIDEO_STORAGE_SIGNING_SECRET), false);
    assert.equal(storage.validCapability('a'.repeat(64) + '/' + 'b'.repeat(64), null, env.VIDEO_STORAGE_SIGNING_SECRET), false);
});

test('chat media links are archived in markdown while ordinary links and typed text values stay text', async () => {
    const f = fixture();
    const result = await storage.archiveMediaFields({ messages: [{ content: 'Result: ![image](https://cdn.example/picture.png?sig=old). See https://docs.example/guide.' }], outputs: [{ type: 'text', value: 'https://cdn.example/not-an-output.png' }] }, f.options);
    assert.match(result.messages[0].content, /!\[image\]\(\/api\/stored-videos\//);
    assert.ok(result.messages[0].content.includes('See https://docs.example/guide.'));
    assert.equal(result.outputs[0].value, 'https://cdn.example/not-an-output.png');
    assert.equal(f.downloads, 1);
    const migrated = await storage.rewriteArchivedLinks({ markdown: '![old](https://cdn.example/picture.png?sig=expired)' }, f.options);
    assert.match(migrated.markdown, /!\[old\]\(\/api\/stored-videos\//);
    assert.ok(!migrated.markdown.includes('expired'));
});

test('signed S3 media echoes resolve to the existing object without redownload or manifest access', async () => {
    const f = fixture();
    const original = await storage.archiveMediaFields({ url: 'https://cdn.example/image.png' }, f.options);
    const key = new URL(original.url, 'https://studio.example').pathname.replace('/api/stored-videos/', '');
    const signed = env.VIDEO_STORAGE_ENDPOINT + '/' + env.VIDEO_STORAGE_BUCKET + '/' + key + '?X-Amz-Signature=temporary';
    const result = await storage.archiveMediaFields({ image_url: signed }, { ...f.options, requestId: 'different-job' });
    assert.equal(result.image_url, original.url);
    assert.equal(f.objects.size, 1); assert.equal(f.downloads, 1);
    const wrongOwner = env.VIDEO_STORAGE_ENDPOINT + '/' + env.VIDEO_STORAGE_BUCKET + '/' + '0'.repeat(64) + '/' + 'a'.repeat(64) + '?sig=private';
    await assert.rejects(storage.archiveMediaFields({ url: wrongOwner }, f.options), /Invalid stored media owner/);
    const manifestUrl = env.VIDEO_STORAGE_ENDPOINT + '/' + env.VIDEO_STORAGE_BUCKET + '/history/' + key + '.json?sig=private';
    await assert.rejects(storage.archiveMediaFields({ url: manifestUrl }, f.options), /Invalid stored media owner/);
});

test('explicit history deletion survives provider backfill and keeps shared blobs intact', async () => {
    const f = fixture();
    const data = { status: 'completed', images: ['https://cdn.example/image.png'] };
    await storage.archivePredictionResult(data, f.options);
    await storage.deleteArchivedResult('job-1', f.options);
    assert.equal(await storage.isArchivedResultDeleted('job-1', f.options), true);
    assert.equal(await storage.getArchivedResult('job-1', f.options), null);
    assert.deepEqual((await storage.listArchivedHistory(f.options)).items, []);
    assert.deepEqual((await storage.getMediaCatalog(f.options)).items, []);
    assert.equal(f.objects.size, 1);
    const retry = await storage.archivePredictionResult(data, f.options);
    assert.equal(retry.status, 'deleted'); assert.deepEqual(retry.outputs, []);
    assert.equal(f.downloads, 1);
    const backfill = await storage.archiveHistory({ items: [{ request_id: 'job-1', status: 'completed', output: data }] }, f.options);
    assert.deepEqual(backfill.items, []);
    assert.equal(await storage.isArchivedResultDeleted('job-1', { ...f.options, apiKey: 'another-owner' }), false);
});

test('structured canvas and workflow JSON echoes preserve encoding and durable references', async () => {
    const f = fixture();
    const original = await storage.archiveMediaFields({ url: 'https://cdn.example/image.png' }, f.options);
    const key = new URL(original.url, 'https://studio.example').pathname.replace('/api/stored-videos/', '');
    const signed = env.VIDEO_STORAGE_ENDPOINT + '/' + env.VIDEO_STORAGE_BUCKET + '/' + key + '?X-Amz-Signature=temporary';
    const raw = { canvas_state: JSON.stringify({ nodes: [{ data: { src: signed } }] }), workflow_definition: JSON.stringify({ nodes: [{ image_url: signed }] }) };
    const result = await storage.archiveMediaFields(raw, f.options);
    assert.equal(typeof result.canvas_state, 'string');
    assert.equal(JSON.parse(result.canvas_state).nodes[0].data.src, original.url);
    assert.equal(JSON.parse(result.workflow_definition).nodes[0].image_url, original.url);
    assert.equal(f.downloads, 1);
    const migrated = await storage.rewriteArchivedLinks(raw, f.options);
    assert.equal(JSON.parse(migrated.canvas_state).nodes[0].data.src, original.url);
});

test('archived source mappings survive provider expiry across route/request identities', async () => {
    const f = fixture();
    const first = await storage.archiveMediaFields({ url: 'https://cdn.example/image.png?sig=one' }, f.options);
    f.options.downloadMedia = async () => { throw Error('provider has expired'); };
    const second = await storage.archiveMediaFields({ assets: [{ url: 'https://cdn.example/image.png?sig=two' }] }, { ...f.options, requestId: 'another-route-id' });
    assert.equal(second.assets[0].url, first.url);
    assert.equal(f.objects.size, 1);
});

test('explicit markdown images and conversation wrappers support extensionless media', async () => {
    const f = fixture();
    const result = await storage.archiveMediaFields({ conversation: { messages: [{ content: '![result](https://cdn.example/asset?id=1)' }] } }, f.options);
    assert.match(result.conversation.messages[0].content, /!\[result\]\(\/api\/stored-videos\//);
    assert.equal(f.downloads, 1);
});

test('actual workflow URL-typed outputs are archived while text values remain untouched', async () => {
    const f=fixture();
    const result=await storage.archiveMediaFields({nodes:{image:[{status:'completed',result:{outputs:[{type:'image_url',value:'https://cdn.example/image.png'},{type:'video_url',value:'https://cdn.example/video.mp4'},{type:'audio_url',value:'https://cdn.example/audio.mp3'},{type:'text',value:'https://example.com/page'}]}}]}},f.options);
    const outputs=result.nodes.image[0].result.outputs;
    for(const output of outputs.slice(0,3)) assert.match(output.value,/^\/api\/stored-videos\//);
    assert.equal(outputs[3].value,'https://example.com/page');
});
