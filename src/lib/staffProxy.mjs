import { createHash, randomUUID } from 'node:crypto';
import { mediaOptions, persistUpload, persistProviderResponse, translateMediaInputs, canonicalMediaKey } from './staffMedia.mjs';
import { isStaffMode, getProviderAuth, upstreamHeaders, StaffAuthError } from './staffAuth.mjs';
import videoStorage from './videoStorage.cjs';
import * as catalog from '../../packages/studio/src/models.js';

const endpoints = new Set(Object.values(catalog).filter(Array.isArray).flatMap(models => models.map(model => model.endpoint || model.id)).filter(Boolean));
// These are Studio's media/account-read APIs, never key or billing administration.
export function allowedProviderPath(path, method) {
    if (/^\/(agents|workflow)(\/|$)/.test(path)) return ['GET','POST','PUT','PATCH','DELETE'].includes(method);
    if (/^\/api\/v1\/creative-agent(\/|$)/.test(path)) return ['GET','POST','PATCH','DELETE'].includes(method);
    if (path.startsWith('/app/')) return ['get_file_upload_url', 'get_upload_file', 'calculate_dynamic_cost', 'interest', 'interests'].includes(path.slice(5));
    const relative = path.replace(/^\/api\/v1\//, '');
    if (method === 'POST' && endpoints.has(relative)) return true;
    if (method === 'POST' && ['upload_file', 'app/calculate_dynamic_cost', 'qwen-image-layered', 'motion-graphics-edit', 'bytedance-seedream-5.0-pro-layer'].includes(relative)) return true;
    if (method === 'GET' && ['account/balance', 'history', 'get_upload_url'].includes(relative)) return true;
    if (method === 'GET' && /^predictions\/[^/]+\/(result|status)$/.test(relative)) return true;
    if (method === 'DELETE' && /^predictions\/[^/]+\/media$/.test(relative)) return true;
    return method === 'POST' && /^models\/[^/]+\/estimate-cost$/.test(relative);
}

export function providerTarget(originalPath, method, search = '') {
    // Reject decoded separators and dot segments before building a fixed-origin URL.
    const parts = originalPath.split('/').slice(1).map(decodeURIComponent);
    if (parts.some(part => part === '.' || part === '..' || /[\\/\x00-\x1f]/.test(part))) throw new StaffAuthError('Invalid API path', 400);
    let path = '/' + parts.join('/');
    if (path.startsWith('/api/api/v1/')) path = path.slice(4);
    else if (/^\/api\/(agents|workflow|app)(\/|$)/.test(path)) path = path.slice(4);
    if (path === '/api/v1/get_upload_url' || path === '/app/get_upload_file') path = '/app/get_file_upload_url';
    if (!allowedProviderPath(path, method)) throw new StaffAuthError('API operation is not available to staff', 403);
    return new URL(path.split('/').map(encodeURIComponent).join('/') + search, 'https://api.muapi.ai');
}

export async function proxyStaffRequest(request) {
    const headers = { 'Cache-Control': 'private, no-store' };
    try {
        if (!isStaffMode()) throw new StaffAuthError('Not found', 404);
        const auth = await getProviderAuth(request);
        const incoming = new URL(request.url);
        const originalPath = request.headers.get('x-studio-api-path') || incoming.searchParams.get('__studio_path');
        if (!originalPath) throw new StaffAuthError('Invalid API path', 400);
        incoming.searchParams.delete('__studio_path');
        const target = providerTarget(originalPath, request.method, incoming.search);
        const prediction = /^\/api\/v1\/predictions\/([^/]+)\/result$/.exec(target.pathname);
        if (request.method === 'POST' && target.pathname === '/api/v1/upload_file') return persistUpload(request, auth);
        if (target.pathname === '/app/get_file_upload_url') {
            mediaOptions(auth);
            return Response.json({ url: '/api/upload-binary', fields: {} }, { headers });
        }
        if (prediction && request.method === 'GET') {
            const options = mediaOptions(auth);
            if (await videoStorage.isArchivedResultDeleted(prediction[1], options)) return Response.json({ error: 'Media was removed from history' }, { status: 404, headers });
            const cached = await videoStorage.getArchivedResult(prediction[1], options);
            if (cached) return Response.json(cached, { headers });
        }
        const isHistory = target.pathname === '/api/v1/history' && request.method === 'GET';
        if (isHistory) {
            // The durable catalog has its own cursor; never send it to MuAPI.
            return Response.json(await videoStorage.listArchivedHistory({ ...mediaOptions(auth), limit: incoming.searchParams.get('limit'), cursor: incoming.searchParams.get('cursor') }), { headers });
        }
        let body;
        if (!['GET','HEAD'].includes(request.method)) {
            if (request.headers.get('content-type')?.includes('application/json')) {
                const raw = await request.text();
                const input = raw ? JSON.parse(raw) : null;
                if (target.pathname === '/workflow/cloudfront-signed-url') {
                    const options = mediaOptions(auth);
                    if (typeof input?.url !== 'string') throw new StaffAuthError('Missing media URL', 400);
                    const media = await persistProviderResponse({ url: input.url }, auth, 'download:' + createHash('sha256').update(String(input.url)).digest('hex'));
                    if (!canonicalMediaKey(media.url)) throw new StaffAuthError('Media has not been archived', 503);
                    return Response.json({ signed_url: media.url, url: media.url }, { headers });
                }
                body = input == null ? undefined : JSON.stringify(await translateMediaInputs(input, auth));
            } else body = await request.arrayBuffer();
        }
        const upstream = await fetch(target, {
            method: request.method, headers: upstreamHeaders(request, auth.apiKey), body,
            redirect: 'error', cache: 'no-store',
        });
        const deletion = /^\/api\/v1\/predictions\/([^/]+)\/media$/.exec(target.pathname);
        if (deletion && request.method === 'DELETE' && (upstream.ok || upstream.status === 404)) {
            await videoStorage.deleteArchivedResult(deletion[1], mediaOptions(auth));
            return Response.json({ deleted: true }, { headers });
        }
        if (upstream.status === 204) return new Response(null, { status: 204, headers });
        let data = await upstream.json();
        if (upstream.ok && prediction) data = await videoStorage.archivePredictionResult(data, { ...mediaOptions(auth), requestId: prediction[1] });
        const mediaResponse = /^\/(?:workflow|agents)\//.test(target.pathname) || target.pathname.startsWith('/api/v1/creative-agent/');
        const templateResponse = /(?:templates|featured|suggest|skills|node-schemas|estimate-cost|get-template)/.test(target.pathname);
        if (upstream.ok && mediaResponse && !templateResponse) {
            data = await persistProviderResponse(data, auth, target.pathname);
        }
        const hasMedia = data && ['outputs', 'images', 'video', 'audio', 'url', 'output'].some(field => data[field]);
        if (upstream.ok && request.method === 'POST' && target.pathname.startsWith('/api/v1/') && !mediaResponse && hasMedia) {
            data = await videoStorage.archivePredictionResult({ ...data, status: data.status || 'completed' }, {
                ...mediaOptions(auth), requestId: data.request_id || data.id || randomUUID(),
            });
        }
        // Provider failures must not echo request credentials or infrastructure details.
        if (!upstream.ok) {
            const code = data?.detail?.error?.code || data?.error?.code;
            if (code === 'INSUFFICIENT_CREDITS') {
                const detail = target.pathname === '/api/v1/upload_file'
                    ? 'MuAPI requires a positive credit balance for file uploads, including sandbox uploads.'
                    : 'The shared MuAPI account has insufficient credits.';
                return Response.json({ error: code, detail }, { status: 402, headers });
            }
            return Response.json({ error: 'AI provider request failed', providerStatus: upstream.status }, { status: upstream.status, headers });
        }
        return Response.json(data, { status: upstream.status, headers });
    } catch (error) {
        const status = error instanceof StaffAuthError ? error.status : 503;
        return Response.json({ error: error instanceof StaffAuthError ? error.message : 'AI service temporarily unavailable; retry' }, { status, headers });
    }
}
