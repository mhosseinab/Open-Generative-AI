import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/smoke-container.mjs IMAGE');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const directory = mkdtempSync(join(tmpdir(), 'studio-container-'));
chmodSync(directory, 0o755);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://container-test.cloudflareaccess.com';
const audience = 'container-studio';
function token(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, email: 'qa@example.com', sub: 'qa', iat: now, exp: now + 300, ...overrides })).toString('base64url');
    const body = `${header}.${payload}`;
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
writeFileSync(join(directory, 'jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }] }), { mode: 0o444 });
writeFileSync(join(directory, 'provider'), 'synthetic-container-key', { mode: 0o444 });
copyFileSync(fileURLToPath(new URL('../tests/container/preload.mjs', import.meta.url)), join(directory, 'preload.mjs'));
chmodSync(join(directory, 'preload.mjs'), 0o444);
let container;
try {
    container = docker('run', '-d', '--read-only', '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/app/.next/cache:uid=1000,gid=1000,mode=0750', '-p', '127.0.0.1::3000', '--mount', `type=bind,src=${directory},dst=/qa,readonly`, '-e', 'NODE_OPTIONS=--import=/qa/preload.mjs', '-e', 'STAFF_AUTH_MODE=cloudflare', '-e', `CF_ACCESS_ISSUER=${issuer}`, '-e', `CF_ACCESS_AUDIENCE=${audience}`, '-e', 'MUAPI_API_KEY_FILE=/qa/provider', '-e', 'STUDIO_PUBLIC_ORIGIN=https://studio.example.com', image);
    const port = JSON.parse(docker('inspect', container))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort;
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'cf-access-jwt-assertion': token(), 'x-api-key': 'browser-override' };
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
        try { ready = (await fetch(`${base}/studio`)).ok; } catch { /* Container is still starting. */ }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, 'Container did not become ready');
    for (const path of ['/api/staff-session', '/api/api/v1/account/balance', '/api/v1/account/balance', '/api/agents/user/agents', '/api/workflow/get-workflow-defs']) {
        const response = await fetch(base + path, { headers });
        assert.equal(response.status, 200, `${path}: ${await response.text()}`);
    }
    assert.equal((await fetch(base + '/api/staff-session')).status, 401);
    assert.equal((await fetch(base + '/api/staff-session', { headers: { 'cf-access-jwt-assertion': token({ aud: 'wrong-app' }) } })).status, 401);
    assert.equal((await fetch(base + '/api/api/v1/keys', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/api/v1/nano-banana', { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body: '{}' })).status, 403);
    const thumbnail = await fetch(base + '/_next/image?url=%2Fassets%2Flayers%2Fsample.webp&w=64&q=75');
    assert.equal(thumbnail.status, 200);
    assert.match(thumbnail.headers.get('content-type'), /^image\//);
    const user = docker('exec', container, 'node', '-e', 'console.log(process.getuid())');
    assert.equal(user, '1000');
    console.log('Container smoke passed: pages, sharp, staff JWT, rewritten APIs, key isolation, denial paths, read-only non-root runtime');
} finally {
    if (container) docker('rm', '-f', container);
    rmSync(directory, { recursive: true, force: true });
}
