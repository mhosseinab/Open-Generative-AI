import { createHash } from 'node:crypto';
import mediaStorage from '../../../src/lib/videoStorage.cjs';
import { isStaffMode, getStaffIdentity, STAFF_MEDIA_OWNER, StaffAuthError } from '../../../src/lib/staffAuth.mjs';
import { mediaOptions, canonicalMediaKey } from '../../../src/lib/staffMedia.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'private, no-store' };
async function catalog(request) {
    try {
        if (!isStaffMode()) return Response.json({ links: {}, items: [] }, { headers });
        await getStaffIdentity(request);
        const options = mediaOptions({ ownerId: STAFF_MEDIA_OWNER });
        const failures = [];
        if (request.method === 'POST') {
            const body = await request.json();
            if (!Array.isArray(body.sources) || body.sources.length > 50 || body.sources.some(value => typeof value !== 'string' || value.length > 8192)) throw new StaffAuthError('Import accepts up to 50 media sources', 400);
            for (const source of new Set(body.sources)) {
                try {
                    const saved = await mediaStorage.archiveMediaFields({ url: source }, { ...options, requestId: 'import:' + createHash('sha256').update(mediaStorage.normalizedSource(source) || source).digest('hex') });
                    if (!canonicalMediaKey(saved.url)) throw new Error('Original media was not archived');
                } catch {
                    failures.push({ source: mediaStorage.normalizedSource(source) || '', error: 'Original media could not be archived; it may have expired' });
                }
            }
        }
        return Response.json({ ...await mediaStorage.getMediaCatalog(options), failures }, { headers });
    } catch (error) {
        return Response.json({ error: error instanceof StaffAuthError ? error.message : 'Saved media catalog is temporarily unavailable; retry' }, { status: error instanceof StaffAuthError ? error.status : 503, headers });
    }
}
export const GET = catalog;
export const POST = catalog;
