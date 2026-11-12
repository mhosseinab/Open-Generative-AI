import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStaffToken, getProviderAuth, upstreamHeaders } from '../src/lib/staffAuth.mjs';
import { providerTarget, proxyStaffRequest, allowedProviderPath } from '../src/lib/staffProxy.mjs';

const issuer = 'https://staff-test.cloudflareaccess.com';
const audience = 'studio-test-audience';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
async function token(overrides = {}) {
    return new SignJWT({ email: 'staff@example.com', sub: 'staff-id', ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuedAt()
        .setIssuer(overrides.iss || issuer).setAudience(overrides.aud || audience)
        .setExpirationTime(overrides.exp || '5m').sign(privateKey);
}
const options = { issuer, audience, keys: publicKey };

test('JWT verification denies missing, spoofed, expired, wrong issuer/audience/identity tokens', async () => {
    assert.equal((await verifyStaffToken(await token(), options)).email, 'staff@example.com');
    for (const value of [undefined, 'fake', await token({ exp: 1 }), await token({ iss: 'https://other.example' }), await token({ aud: 'other' }), await token({ email: '' }), await token({ nbf: Math.floor(Date.now()/1000)+600 })]) {
        await assert.rejects(verifyStaffToken(value, options), { status: 401 });
    }
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ email: 'staff@example.com', sub: 'id' }).setProtectedHeader({ alg:'RS256' }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(other.privateKey);
    await assert.rejects(verifyStaffToken(forged, options), { status: 401 });
});

test('staff proxy injects only server key, denies admin paths, and fails closed without configuration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-key-test-'));
    const file = join(dir, 'provider');
    const originalFetch = globalThis.fetch;
    Object.assign(process.env, { STAFF_AUTH_MODE:'cloudflare', CF_ACCESS_ISSUER:issuer, CF_ACCESS_AUDIENCE:audience, MUAPI_API_KEY_FILE:file });
    await writeFile(file, 'server-only-test-key');
    let upstreamCalls = 0;
    globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
        upstreamCalls++;
        assert.equal(new URL(url).origin, 'https://api.muapi.ai');
        assert.equal(init.headers.get('x-api-key'), 'server-only-test-key');
        for (const name of ['cookie','authorization','cf-access-jwt-assertion','cf-access-authenticated-user-email','cf-access-client-secret']) assert.equal(init.headers.get(name), null);
        return Response.json({ balance: 7 });
    };
    try {
        const headers = { 'cf-access-jwt-assertion':await token(), 'x-api-key':'browser-key', authorization:'Bearer browser', cookie:'secret', 'cf-access-client-secret':'secret' };
        const request = new Request('https://studio.example/api/staff-proxy?__studio_path=/api/api/v1/account/balance', { headers });
        const auth = await getProviderAuth(request);
        assert.equal(auth.apiKey, 'server-only-test-key');
        const response = await proxyStaffRequest(request);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { balance:7 });
        assert.equal(upstreamCalls, 1);
        assert.equal((await proxyStaffRequest(new Request(request.url, {headers:{'cf-access-authenticated-user-email':'staff@example.com','x-api-key':'bypass'}}))).status,401);
        globalThis.fetch = async () => Response.json({ detail: { error: { code: 'INSUFFICIENT_CREDITS', message: 'provider details must not be reflected' } } }, { status: 403 });
        const upload = new Request('https://studio.example/api/staff-proxy?__studio_path=/api/api/v1/upload_file', { method: 'POST', headers: { ...headers, origin: 'https://studio.example' }, body: 'fixture' });
        process.env.STUDIO_PUBLIC_ORIGIN = 'https://studio.example';
        const deniedUpload = await proxyStaffRequest(upload);
        assert.equal(deniedUpload.status, 402);
        const uploadError = await deniedUpload.json();
        assert.equal(uploadError.error, 'INSUFFICIENT_CREDITS');
        assert.match(uploadError.detail, /positive credit balance.*sandbox uploads/);
        assert.ok(!JSON.stringify(uploadError).includes('provider details'));
        await writeFile(file, '');
        assert.equal((await proxyStaffRequest(request)).status, 503);
        assert.equal(upstreamCalls,1);
        process.env.STAFF_AUTH_MODE='byok';
        assert.equal((await getProviderAuth(new Request(request.url,{headers:{'x-api-key':'byok'}}))).apiKey,'byok');
    } finally {
        globalThis.fetch=originalFetch;
        for (const name of ['STAFF_AUTH_MODE','CF_ACCESS_ISSUER','CF_ACCESS_AUDIENCE','MUAPI_API_KEY_FILE','STUDIO_PUBLIC_ORIGIN']) delete process.env[name];
        await rm(dir,{recursive:true});
    }
});

test('targets stay on fixed provider origin and key/control-plane paths cannot be reached', () => {
    assert.equal(providerTarget('/api/api/v1/account/balance','GET').pathname,'/api/v1/account/balance');
    assert.equal(providerTarget('/api/v1/predictions/job/result','GET').origin,'https://api.muapi.ai');
    for (const path of ['/api/api/v1/keys','/api/v1/account/keys','/api/app/keys','/api/agents/%2e%2e/keys','/api/agents/a%2fb','//evil.example/keys','/api/agents/%5c..']) assert.throws(()=>providerTarget(path,'POST'));
    const headers=upstreamHeaders(new Request('https://example.com',{headers:{'content-type':'application/json','cookie':'private'}}),'server');
    assert.equal(headers.get('content-type'),'application/json');
    assert.equal(headers.get('cookie'),null);
});

test('staff can use ancillary media and design session actions', () => {
 for (const endpoint of ['motion-graphics-edit', 'bytedance-seedream-5.0-pro-layer']) assert.ok(allowedProviderPath('/api/v1/'+endpoint, 'POST'));
 assert.ok(allowedProviderPath('/api/v1/creative-agent/sessions/test', 'DELETE'));
});
