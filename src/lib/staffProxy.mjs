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
        const body = ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
        const upstream = await fetch(target, {
            method: request.method, headers: upstreamHeaders(request, auth.apiKey), body,
            redirect: 'error', cache: 'no-store',
        });
        if (upstream.status === 204) return new Response(null, { status: 204, headers });
        let data = await upstream.json();
        const prediction = /^\/api\/v1\/predictions\/([^/]+)\/result$/.exec(target.pathname);
        if (upstream.ok && prediction) data = await videoStorage.archivePredictionResult(data, { apiKey: auth.ownerId, requestId: prediction[1] });
        if (upstream.ok && target.pathname === '/app/get_file_upload_url' && data.url) {
            data.fields = { ...data.fields, 'x-proxy-target-url': data.url };
            data.url = '/api/upload-binary';
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
