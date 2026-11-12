import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceMediaIdentity, rewritePersistentMedia, catalogHistory, mergeDurableHistory, restoreDurableMedia } from '../packages/studio/src/durableMedia.js';
import { scopedPersistKey } from '../packages/studio/src/persistKey.js';

const owner = 'a'.repeat(64);
const token = 'f'.repeat(64);
const path = (id, type = 'image') => `/api/stored-videos/${owner}/${id.repeat(64)}?token=${token}&type=${type}`;
const source = 'https://cdn.example/generated/image.png';
const catalog = {
    links: { [source]: path('b'), 'https://cdn.example/generated/video.mp4': path('c', 'video') },
    items: [
        { request_id: 'image-job', status: 'completed', category: 'Text to Image', model: 'nano-banana', created_at: '2026-11-12T10:00:00Z', output: { images: [path('b')], outputs: [path('b')] } },
        { request_id: 'video-job', status: 'completed', category: 'Text to Video', model: 'seedance', created_at: '2026-11-12T11:00:00Z', output: { outputs: [path('c', 'video')] } },
        { request_id: 'audio-job', status: 'completed', category: 'Text to Audio', created_at: '2026-11-12T09:00:00Z', output: { outputs: [path('d', 'audio')] } },
        { request_id: 'pending', status: 'processing', category: 'Image', output: { outputs: [path('e')] } },
    ],
};
const identity = { staffMode: true, email: 'alice@example.com' };
function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('source matching ignores only expiring query/fragment and rewrites nested media exactly', () => {
    assert.equal(sourceMediaIdentity(source + '?signature=old#preview'), source);
    const state = { url: source + '?signature=old', nested: [{ url: 'https://cdn.example/other.png' }], prompt: 'A scene containing ' + source };
    const rewritten = rewritePersistentMedia(state, catalog.links);
    assert.equal(rewritten.url, path('b'));
    assert.equal(rewritten.nested[0].url, state.nested[0].url);
    assert.equal(rewritten.prompt, state.prompt);
    assert.equal(rewritePersistentMedia(source, { [source]: 'https://other.example/temporary' }), source);
});

test('canonical catalog restores all media types without alias duplicates or incomplete jobs', () => {
    const groups = catalogHistory(catalog);
    assert.equal(groups.image.length, 1);
    assert.equal(groups.video.length, 1);
    assert.equal(groups.audio.length, 1);
    assert.equal(groups.image[0].id, 'image-job');
    const oldStyleUrl = path('b').replace('&type=image', '');
    const merged = mergeDurableHistory([{ id: 'browser-id', url: oldStyleUrl, prompt: 'My saved prompt', timestamp: '2026-11-12T10:00:00Z' }], groups.image);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].prompt, 'My saved prompt');
});

test('migration updates only current staff drafts and preserves unrelated fields and other staff', () => {
    const alice = scopedPersistKey('hg_image_studio_persistent', identity);
    const bob = scopedPersistKey('hg_image_studio_persistent', { staffMode: true, email: 'bob@example.com' });
    const storage = memoryStorage({
        [alice]: JSON.stringify({ prompt: 'Draft prompt', uploadedImageUrls: [source + '?expires=1'], localHistory: [{ id: 'image-job', url: source + '?expires=1', prompt: 'Saved prompt' }] }),
        [bob]: JSON.stringify({ localHistory: [{ url: source }] }),
        unrelated: JSON.stringify({ url: source }),
    });
    restoreDurableMedia(storage, identity, catalog);
    const state = JSON.parse(storage.getItem(alice));
    assert.equal(state.prompt, 'Draft prompt');
    assert.deepEqual(state.uploadedImageUrls, [path('b')]);
    assert.equal(state.localHistory.length, 1);
    assert.equal(state.localHistory[0].url, path('b'));
    assert.equal(state.localHistory[0].prompt, 'Saved prompt');
    assert.equal(JSON.parse(storage.getItem(bob)).localHistory[0].url, source);
    assert.equal(JSON.parse(storage.getItem('unrelated')).url, source);
    const videos = JSON.parse(storage.getItem(scopedPersistKey('hg_video_studio_persistent', identity)));
    assert.equal(videos.localHistory[0].url, path('c', 'video'));
});

test('locally deleted catalog entries stay deleted while newly archived jobs are imported', () => {
    const storage = memoryStorage();
    const key = scopedPersistKey('hg_image_studio_persistent', identity);
    restoreDurableMedia(storage, identity, catalog);
    const state = JSON.parse(storage.getItem(key));
    state.localHistory = [];
    storage.setItem(key, JSON.stringify(state));
    const next = { ...catalog, items: [...catalog.items, { request_id: 'new-job', status: 'completed', category: 'Text to Image', output: { outputs: [path('e')] } }] };
    restoreDurableMedia(storage, identity, next);
    assert.deepEqual(JSON.parse(storage.getItem(key)).localHistory.map(item => item.id), ['new-job']);
});

test('legacy draft migration happens before rewrite and malformed drafts remain recoverable', () => {
    const base = 'hg_image_studio_persistent';
    const storage = memoryStorage({ [base]: JSON.stringify({ uploadedImageUrls: [source] }), [scopedPersistKey('hg_cinema_studio_persistent', identity)]: '{broken' });
    restoreDurableMedia(storage, identity, catalog);
    assert.equal(storage.getItem(base), null);
    assert.equal(JSON.parse(storage.getItem(scopedPersistKey(base, identity))).uploadedImageUrls[0], path('b'));
    assert.equal(storage.getItem(scopedPersistKey('hg_cinema_studio_persistent', identity)), '{broken');
});


test('media type hints distinguish mixed image/video outputs independently of job category', () => {
    const mixed = catalogHistory({ links: {}, items: [{ request_id: 'mixed', status: 'completed', category: 'Text to Video', output: { outputs: [path('b', 'video')], images: [path('c', 'image')] } }] });
    assert.equal(mixed.image.length, 1);
    assert.equal(mixed.video.length, 1);
});

test('legacy source collection stays within staff media fields and preserves signed URLs for copying', async () => {
    const { collectLegacyMediaSources } = await import('../packages/studio/src/durableMedia.js');
    const alice = scopedPersistKey('hg_image_studio_persistent', identity);
    const bob = scopedPersistKey('hg_image_studio_persistent', { staffMode: true, email: 'bob@example.com' });
    const storage = memoryStorage({
        [alice]: JSON.stringify({
            uploadedImageUrls: [source + '?signature=current', 'blob:preview'],
            uploadHistory: [{ url: source + '?signature=old', thumbnail: 'data:image/png;base64,local' }],
            localHistory: [{ url: 'https://cdn.example/old-output.webp?signature=old', model: { thumbnail: 'https://models.example/model.webp' }, href: 'https://website.example' }],
            prompt: 'https://not-an-input.example/image.png',
            modelThumbnail: 'https://models.example/cover.png',
            params: { reference_image: 'https://cdn.example/reference.png?token=source', url: 'https://website.example/arbitrary' },
        }),
        [bob]: JSON.stringify({ uploadedImageUrls: ['https://cdn.example/bob.png'] }),
        unrelated: JSON.stringify({ videoUrl: 'https://cdn.example/unrelated.mp4' }),
    });
    const notifications = [{ resultUrl: 'https://cdn.example/notice.mp4?expires=1', label: 'https://not-an-input.example/label.png' }];
    const urls = collectLegacyMediaSources(storage, identity, {}, notifications);
    assert.deepEqual(urls, [source + '?signature=current', 'https://cdn.example/old-output.webp?signature=old', 'https://cdn.example/reference.png?token=source', 'https://cdn.example/notice.mp4?expires=1']);
    assert.deepEqual(collectLegacyMediaSources(storage, identity, { [source]: path('b') }), ['https://cdn.example/old-output.webp?signature=old', 'https://cdn.example/reference.png?token=source']);
});

test('legacy media imports are batched at fifty and retain successful canonical mappings', async () => {
    const { importLegacyMediaSources } = await import('../packages/studio/src/durableMedia.js');
    const sources = Array.from({ length: 103 }, (_, i) => `https://cdn.example/${i}.png?signature=current`);
    const batches = [];
    const imported = await importLegacyMediaSources(sources, { links: {}, items: [] }, async (url, options) => {
        assert.equal(url, '/api/media-catalog');
        assert.equal(options.method, 'POST');
        const batch = JSON.parse(options.body).sources;
        batches.push(batch);
        assert.ok(batch.length <= 50);
        const links = Object.fromEntries(batch.slice(0, -1).map(source => [sourceMediaIdentity(source), path('b')]));
        return Response.json({ links, items: [], failures: [{ source: sourceMediaIdentity(batch.at(-1)), error: 'Original expired' }] });
    });
    assert.deepEqual(batches.map(batch => batch.length), [50, 50, 3]);
    assert.equal(Object.keys(imported.catalog.links).length, 100);
    assert.equal(imported.failures.length, 3);
    assert.equal(imported.catalog.links['https://cdn.example/0.png'], path('b'));
    assert.equal(imported.catalog.links['https://cdn.example/49.png'], undefined);
});

test('a failed import batch leaves originals unmapped and marks remaining sources without fake links', async () => {
    const { importLegacyMediaSources } = await import('../packages/studio/src/durableMedia.js');
    const sources = Array.from({ length: 51 }, (_, i) => `https://cdn.example/${i}.png`);
    let calls = 0;
    const result = await importLegacyMediaSources(sources, { links: {}, items: [] }, async () => {
        calls++;
        return Response.json({ error: 'Unavailable' }, { status: 503 });
    });
    assert.equal(calls, 1);
    assert.equal(result.failures.length, 51);
    assert.deepEqual(result.catalog.links, {});
});
