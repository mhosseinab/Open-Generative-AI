import assert from 'node:assert/strict';
import test from 'node:test';

// The package chooses its browser proxy at module load time.
globalThis.window = { location: { protocol: 'https:' } };
const { getUserBalance } = await import('../packages/studio/src/muapi.js');
const { pollForGenerationResult } = await import('../packages/studio/src/utils/generationLifecycle.js');
const { scopedPersistKey } = await import('../packages/studio/src/persistKey.js');
const staffIdentity = { staffMode: true, email: 'alice@example.com' };

test('staff balance requests use the local proxy without a browser API key', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, '/api/api/v1/account/balance');
        assert.equal(new Headers(options.headers).has('x-api-key'), false);
        return Response.json({ balance: 12 });
    });
    assert.deepEqual(await getUserBalance(staffIdentity), { balance: 12 });
});

test('bring-your-own-key clients retain their provider header', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(new Headers(options.headers).get('x-api-key'), 'byok-test-key');
        return Response.json({ balance: 3 });
    });
    await getUserBalance('byok-test-key');
});

test('staff polling uses the proxy without sending the identity marker as a key', async () => {
    const result = await pollForGenerationResult({
        baseUrl: '/api', requestId: 'request-1', apiKey: staffIdentity,
        interval: 0, maxAttempts: 1,
        fetchImpl: async (url, options) => {
            assert.equal(url, '/api/api/v1/predictions/request-1/result');
            assert.equal(new Headers(options.headers).has('x-api-key'), false);
            return Response.json({ status: 'completed', outputs: [] });
        },
    });
    assert.equal(result.status, 'completed');
});

test('browser drafts stay separate for different staff identities', () => {
    const aliceKey = scopedPersistKey('video-draft', staffIdentity);
    const bobKey = scopedPersistKey('video-draft', { staffMode: true, email: 'bob@example.com' });
    assert.notEqual(aliceKey, bobKey);
    assert.equal(scopedPersistKey('video-draft', staffIdentity), aliceKey);
});
