import { scopedPersistKey, migrateLegacyPersistKey } from './persistKey.js';

const STUDIO_KEYS = [
    'hg_image_studio_persistent', 'hg_video_studio_persistent', 'hg_audio_studio_persistent',
    'hg_clipping_studio_persistent', 'hg_cinema_studio_persistent', 'hg_vibe_motion_studio_persistent',
    'hg_recast_studio_persistent', 'hg_motion_control_studio_persistent', 'hg_marketing_studio_persistent',
    'hg_lipsync_studio_persistent', 'hg_recast_studio_assets', 'hg_motion_control_assets',
];
const HISTORY_KEYS = {
    image: ['hg_image_studio_persistent', 'localHistory'],
    video: ['hg_video_studio_persistent', 'localHistory'],
    audio: ['hg_audio_studio_persistent', 'internalHistory'],
};

export function sourceMediaIdentity(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.origin + url.pathname : null;
    } catch { return null; }
}

export function isPersistentMediaUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value, 'https://studio.invalid');
        return /^\/api\/stored-(?:videos|media)\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(url.pathname)
            && /^[a-f0-9]{64}$/.test(url.searchParams.get('token') || '');
    } catch { return false; }
}

export function rewritePersistentMedia(value, links = {}) {
    if (typeof value === 'string') {
        const identity = sourceMediaIdentity(value);
        const target = identity && links[identity];
        return isPersistentMediaUrl(target) ? target : value;
    }
    if (Array.isArray(value)) return value.map(item => rewritePersistentMedia(item, links));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePersistentMedia(item, links)]));
    }
    return value;
}


const MEDIA_FIELDS = new Set([
    'image', 'video', 'audio', 'imageurl', 'videourl', 'audiourl', 'fileurl',
    'imageurls', 'videourls', 'audiourls', 'imageslist', 'videoslist', 'audioslist',
    'uploadedimage', 'uploadedimageurls', 'uploadedendimageurl', 'uploadedvideourls', 'uploadedaudiourls',
    'productimage', 'avatarimage', 'additionalimages', 'referenceimage', 'resulturl', 'outputurl',
    'canvasurl', 'activeresulturl',
]);
const MEDIA_CONTAINERS = new Set(['history', 'localhistory', 'internalhistory', 'uploadhistory', 'images', 'videos', 'audios', 'outputs', 'output', 'results', 'result']);
const NON_MEDIA_FIELDS = new Set(['model', 'modelinfo', 'selectedmodel', 'selectedfamily', 'modelthumbnail', 'modelthumbnailurl', 'documentationurl', 'website', 'websiteurl', 'href', 'link', 'prompt', 'title', 'name', 'description']);

function scopedStudioKeys(storage, identity) {
    return STUDIO_KEYS.map(base => {
        const key = scopedPersistKey(base, identity);
        migrateLegacyPersistKey(base, key, storage);
        return key;
    });
}

export function collectLegacyMediaSources(storage, identity, links = {}, notifications = []) {
    if (!identity?.staffMode || !identity.email) return [];
    const sources = new Map();
    function collect(value, field = '', mediaContext = false) {
        const name = field.replace(/[_-]/g, '').toLowerCase();
        if (NON_MEDIA_FIELDS.has(name)) return;
        const mediaField = MEDIA_FIELDS.has(name);
        const context = mediaContext || mediaField || MEDIA_CONTAINERS.has(name);
        if (typeof value === 'string') {
            const isMedia = mediaField || (context && ['', 'url', 'thumbnail', 'thumbnailurl', 'preview', 'previewurl', 'poster', 'posterurl'].includes(name));
            const source = isMedia && sourceMediaIdentity(value);
            if (source && !isPersistentMediaUrl(value) && !isPersistentMediaUrl(links[source]) && !sources.has(source)) sources.set(source, value);
        } else if (Array.isArray(value)) {
            value.forEach(item => collect(item, '', context));
        } else if (value && typeof value === 'object') {
            Object.entries(value).forEach(([key, item]) => collect(item, key, context));
        }
    }
    for (const key of scopedStudioKeys(storage, identity)) {
        try {
            const state = JSON.parse(storage.getItem(key) || 'null');
            collect(state, Array.isArray(state) ? 'history' : '');
        } catch { /* The normal draft recovery flow retains malformed records. */ }
    }
    collect(notifications, 'history');
    return [...sources.values()];
}

export async function importLegacyMediaSources(sources, initialCatalog, fetchImpl = fetch) {
    let catalog = initialCatalog;
    const failures = new Map();
    for (let start = 0; start < sources.length; start += 50) {
        const batch = sources.slice(start, start + 50);
        try {
            const response = await fetchImpl('/api/media-catalog', {
                method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sources: batch }),
            });
            if (!response.ok) throw new Error('Media import unavailable');
            const imported = await response.json();
            if (!imported || !imported.links || typeof imported.links !== 'object' || Array.isArray(imported.links) || !Array.isArray(imported.items)) throw new Error('Invalid media import response');
            catalog = { links: { ...catalog.links, ...imported.links }, items: imported.items };
            for (const failure of imported.failures || []) failures.set(failure.source, failure);
        } catch {
            for (const source of sources.slice(start)) {
                const identity = sourceMediaIdentity(source);
                failures.set(identity, { source: identity, error: 'Media import unavailable' });
            }
            break;
        }
    }
    return { catalog, failures: [...failures.values()].filter(failure => !isPersistentMediaUrl(catalog.links[failure.source])) };
}

function persistentMediaIdentity(value) {
    return isPersistentMediaUrl(value) ? new URL(value, 'https://studio.invalid').pathname : value;
}

function outputUrls(value) {
    if (typeof value === 'string') return isPersistentMediaUrl(value) ? [value] : [];
    if (Array.isArray(value)) return value.flatMap(outputUrls);
    if (!value || typeof value !== 'object') return [];
    return ['outputs', 'output', 'images', 'videos', 'audios', 'url', 'image_url', 'video_url', 'audio_url', 'data', 'result']
        .filter(key => key in value).flatMap(key => outputUrls(value[key]));
}

function historyKind(item, url, links) {
    const type = new URL(url, 'https://studio.invalid').searchParams.get('type');
    if (['image', 'video', 'audio'].includes(type)) return type;
    const category = String(item.category || '').toLowerCase();
    if (/audio|music|speech/.test(category)) return 'audio';
    if (/video|motion|cinema|lip.?sync/.test(category)) return 'video';
    if (/image|photo|layer/.test(category)) return 'image';
    const source = Object.keys(links).find(key => links[key] === url) || '';
    if (/\.(mp4|webm|mov|m4v)$/i.test(source)) return 'video';
    if (/\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(source)) return 'audio';
    if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(source) || item.output?.images) return 'image';
    return null;
}

export function catalogHistory(catalog = {}) {
    const groups = { image: [], video: [], audio: [] };
    for (const item of catalog.items || []) {
        if (!['completed', 'success', 'succeeded'].includes(String(item.status).toLowerCase())) continue;
        const urls = [...new Set(outputUrls(item.output))];
        urls.forEach((url, index) => {
            const kind = historyKind(item, url, catalog.links || {});
            if (!kind) return;
            groups[kind].push({
                id: `${item.request_id}${urls.length > 1 ? `:${index}` : ''}`,
                request_id: item.request_id,
                url,
                prompt: item.prompt || item.output?.prompt || '',
                model: item.model || item.output?.model || '',
                aspect_ratio: item.aspect_ratio || '1:1',
                timestamp: item.created_at || item.output?.created_at || new Date(0).toISOString(),
            });
        });
    }
    return groups;
}

export function mergeDurableHistory(existing = [], archived = []) {
    const byUrl = new Map();
    for (const entry of archived) byUrl.set(persistentMediaIdentity(entry.url), entry);
    for (const entry of existing) {
        if (!entry?.url) continue;
        const identity = persistentMediaIdentity(entry.url);
        byUrl.set(identity, { ...byUrl.get(identity), ...entry });
    }
    return [...byUrl.values()].sort((a, b) => {
        const aTime = new Date(a.timestamp || 0).getTime() || 0;
        const bTime = new Date(b.timestamp || 0).getTime() || 0;
        return bTime - aTime;
    });
}

// Run before the studio panels mount so their existing persistence loaders see
// canonical links. Only this staff member's scoped drafts are touched.
export function restoreDurableMedia(storage, identity, catalog) {
    if (!identity?.staffMode || !identity.email) return;
    const scopedKeys = scopedStudioKeys(storage, identity);
    for (const key of scopedKeys) {
        const stored = storage.getItem(key);
        if (!stored) continue;
        try {
            const rewritten = rewritePersistentMedia(JSON.parse(stored), catalog.links);
            storage.setItem(key, JSON.stringify(rewritten));
        } catch { /* Leave a malformed draft available for its normal recovery flow. */ }
    }
    const groups = catalogHistory(catalog);
    const seenKey = scopedPersistKey('hg_media_catalog_seen', identity);
    let seen = {};
    try { seen = JSON.parse(storage.getItem(seenKey) || '{}') || {}; } catch { /* First successful import will replace corrupt bookkeeping. */ }
    for (const [kind, [baseKey, field]] of Object.entries(HISTORY_KEYS)) {
        if (!groups[kind].length) continue;
        const key = scopedPersistKey(baseKey, identity);
        let state;
        try { state = JSON.parse(storage.getItem(key) || '{}'); } catch { continue; }
        if (!state || Array.isArray(state) || typeof state !== 'object') continue;
        const current = Array.isArray(state[field]) ? state[field] : [];
        const present = new Set(current.map(entry => persistentMediaIdentity(entry?.url)));
        const previouslySeen = new Set(Array.isArray(seen[kind]) ? seen[kind] : []);
        // A previously imported entry removed locally stays removed on this browser.
        const importable = groups[kind].filter(entry => !previouslySeen.has(persistentMediaIdentity(entry.url)) || present.has(persistentMediaIdentity(entry.url)));
        state[field] = mergeDurableHistory(current, importable);
        storage.setItem(key, JSON.stringify(state));
        seen[kind] = [...new Set([...previouslySeen, ...groups[kind].map(entry => persistentMediaIdentity(entry.url))])];
    }
    storage.setItem(seenKey, JSON.stringify(seen));
}
