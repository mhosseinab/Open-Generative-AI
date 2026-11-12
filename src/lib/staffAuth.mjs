import { readFile } from 'node:fs/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class StaffAuthError extends Error {
    constructor(message, status = 401) { super(message); this.status = status; }
}
export const isStaffMode = () => process.env.STAFF_AUTH_MODE === 'cloudflare';
let remoteKeys;
let remoteIssuer;

export async function verifyStaffToken(token, { issuer, audience, keys } = {}) {
    if (!token) throw new StaffAuthError('Staff login required');
    try {
        const { payload } = await jwtVerify(token, keys, {
            issuer, audience, algorithms: ['RS256'],
            requiredClaims: ['exp', 'iat', 'sub', 'email', 'iss', 'aud'],
        });
        if (typeof payload.email !== 'string' || !payload.email.includes('@') || typeof payload.sub !== 'string' || !payload.sub) {
            throw new Error('Missing staff identity');
        }
        return { email: payload.email, sub: payload.sub };
    } catch { throw new StaffAuthError('Staff login required'); }
}

export async function getStaffIdentity(request) {
    const issuer = process.env.CF_ACCESS_ISSUER;
    const audience = process.env.CF_ACCESS_AUDIENCE;
    if (!issuer || !audience || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)) {
        throw new StaffAuthError('Staff authentication is not configured', 503);
    }
    if (remoteIssuer !== issuer) {
        remoteKeys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
        remoteIssuer = issuer;
    }
    if (request.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const expectedOrigin = process.env.STUDIO_PUBLIC_ORIGIN;
        if (!expectedOrigin || request.headers.get('origin') !== expectedOrigin) {
            throw new StaffAuthError('Cross-site request denied', 403);
        }
    }
    return verifyStaffToken(request.headers.get('cf-access-jwt-assertion'), { issuer, audience, keys: remoteKeys });
}

export async function readProviderKey() {
    const file = process.env.MUAPI_API_KEY_FILE;
    if (file) {
        try { return (await readFile(file, 'utf8')).trim(); } catch { return ''; }
    }
    return (process.env.MUAPI_API_KEY || '').trim();
}

export async function getProviderAuth(request) {
    if (isStaffMode()) {
        const identity = await getStaffIdentity(request);
        const apiKey = await readProviderKey();
        if (!apiKey) throw new StaffAuthError('The shared AI provider key has not been configured by an administrator', 503);
        return { ...identity, apiKey, ownerId: 'falak-studio-team' };
    }
    const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace(/^Bearer /, '');
    return { apiKey, ownerId: apiKey };
}

export function upstreamHeaders(request, apiKey) {
    const headers = new Headers();
    for (const name of ['content-type', 'accept']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    headers.set('x-api-key', apiKey);
    return headers;
}
