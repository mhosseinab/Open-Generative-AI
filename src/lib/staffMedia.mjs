import { randomUUID } from 'node:crypto';
import mediaStorage from './videoStorage.cjs';
import { StaffAuthError, getStaffIdentity, STAFF_MEDIA_OWNER } from './staffAuth.mjs';
import { isBlockedFileType } from './uploadProxyTarget.js';

export function mediaOptions(auth) {
    if (!mediaStorage.config()) throw new StaffAuthError('Persistent media storage is not configured', 503);
    return { apiKey: auth.ownerId || STAFF_MEDIA_OWNER };
}

export function canonicalMediaKey(raw, settings = mediaStorage.config(), origin = process.env.STUDIO_PUBLIC_ORIGIN) {
    if (typeof raw !== 'string' || !settings || !origin) return null;
    let url;
    try { url = new URL(raw, origin); } catch { return null; }
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/stored-videos/')) return null;
    const key = url.pathname.slice('/api/stored-videos/'.length);
    if (!mediaStorage.validCapability(key, url.searchParams.get('token'), settings.secret)) {
        throw new StaffAuthError('Invalid stored media reference', 400);
    }
    return key;
}

export async function translateMediaInputs(value, auth, { store, settings = mediaStorage.config(), origin = process.env.STUDIO_PUBLIC_ORIGIN } = {}) {
    const cache = new Map();
    async function translate(raw) {
        const key = canonicalMediaKey(raw, settings, origin);
        if (!key) return raw;
        if (!cache.has(key)) {
            store ||= await mediaStorage.s3Store(settings);
            cache.set(key, store.signedGet(key, 'GET', 3600));
        }
        return cache.get(key);
    }
    async function rewrite(input) {
        if (typeof input === 'string') {
            if (/^(?:https?:\/\/|\/api\/stored-videos\/)/.test(input) && !/\s/.test(input)) return translate(input);
            if (/^\s*[\[{]/.test(input)) {
                let parsed;
                try { parsed = JSON.parse(input); } catch { /* Plain text. */ }
                if (parsed !== undefined) return JSON.stringify(await rewrite(parsed));
            }
            // Agent messages may include canonical media inside Markdown.
            const matches = [...input.matchAll(/(?:https?:\/\/[^\s<>"')\]]+)?\/api\/stored-videos\/[a-f0-9]{64}\/[a-f0-9]{64}\?[^\s<>"')\]]+/g)];
            let result = input;
            for (const match of matches) result = result.replace(match[0], await translate(match[0]));
            return result;
        }
        if (Array.isArray(input)) return Promise.all(input.map(rewrite));
        if (input && typeof input === 'object') return Object.fromEntries(await Promise.all(Object.entries(input).map(async ([key, child]) => [key, await rewrite(child)])));
        return input;
    }
    return rewrite(value);
}

export async function persistUpload(request, auth) {
    const options = mediaOptions(auth);
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file.stream !== 'function') throw new StaffAuthError('Missing upload file', 400);
    if (!file.size) throw new StaffAuthError('Upload file is empty', 400);
    if (!mediaStorage.mediaContentType(file.type, `https://upload.invalid/${encodeURIComponent(file.name || '')}`)) throw new StaffAuthError('Unsupported upload file type', 400);
    if (file.size > 2 * 1024 * 1024 * 1024) throw new StaffAuthError('Media upload exceeds 2 GiB', 413);
    if (isBlockedFileType(file.name, file.type)) throw new StaffAuthError('Unsupported upload file type', 400);
    const url = await mediaStorage.storeUploadedMedia(file, { ...options, requestId: randomUUID() });
    return Response.json({ url, file_url: url }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function persistStaffUpload(request) {
    try {
        await getStaffIdentity(request);
        return await persistUpload(request, { ownerId: STAFF_MEDIA_OWNER });
    } catch (error) {
        return Response.json({ error: error instanceof StaffAuthError ? error.message : 'Media upload could not be saved; retry' }, {
            status: error instanceof StaffAuthError ? error.status : 503,
            headers: { 'Cache-Control': 'private, no-store' },
        });
    }
}

export async function persistProviderResponse(data, auth, id) {
    const options = { ...mediaOptions(auth), requestId: id };
    return mediaStorage.rewriteArchivedLinks(await mediaStorage.archiveMediaFields(data, options), options);
}
