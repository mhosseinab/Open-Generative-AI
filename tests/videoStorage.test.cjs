const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const storage = require('../src/lib/videoStorage.cjs');

const env = {
    VIDEO_STORAGE_ENDPOINT: 'https://hel1.your-objectstorage.com', VIDEO_STORAGE_REGION: 'hel1',
    VIDEO_STORAGE_BUCKET: 'test-videos', VIDEO_STORAGE_ACCESS_KEY_ID: 'test', VIDEO_STORAGE_SECRET_ACCESS_KEY: 'test',
    VIDEO_STORAGE_SIGNING_SECRET: '0123456789abcdef0123456789abcdef',
};
function fixture() {
    const objects = new Map(); let downloads = 0;
    return {
        objects, get downloads() { return downloads; },
        options: { apiKey: 'owner-api-key', requestId: 'job-1', env,
            store: {
                exists: async key => objects.has(key),
                async put(key, video) {
                    const chunks = []; for await (const chunk of video.body) chunks.push(chunk);
                    objects.set(key, Buffer.concat(chunks));
                },
            },
            async downloadVideo() { downloads++; return { body: Readable.from([Buffer.from('video-bytes')]), type: 'video/mp4' }; },
        },
    };
}

test('pending and failed generations never request storage or download', async () => {
    for (const status of ['processing', 'queued', 'failed', 'error']) {
        const f = fixture();const result = { status, outputs: ['https://cdn.example/video.mp4'] };
        assert.strictEqual(await storage.archivePredictionResult(result, f.options), result);
        assert.equal(f.downloads, 0);assert.equal(f.objects.size, 0);
    }
});
test('completed video is streamed to storage and becomes a persistent capability URL', async () => {
    const f = fixture();const result = await storage.archivePredictionResult({status:'completed',outputs:['https://cdn.example/video.mp4']},f.options);
    assert.match(result.outputs[0], /^\/api\/stored-videos\/[a-f0-9]{64}\/[a-f0-9]{64}\?token=[a-f0-9]{64}$/);
    assert.equal([...f.objects.values()][0].toString(),'video-bytes');
    const url = new URL(result.outputs[0], 'https://studio.example');
    const key = url.pathname.replace('/api/stored-videos/','');
    assert.equal(storage.validCapability(key,url.searchParams.get('token'),env.VIDEO_STORAGE_SIGNING_SECRET),true);
    assert.equal(storage.validCapability(key,'0'.repeat(64),env.VIDEO_STORAGE_SIGNING_SECRET),false);
});
test('repeated polls and changing source signatures do not duplicate objects', async () => {
    const f = fixture();
    await storage.archivePredictionResult({status:'completed',outputs:['https://cdn.example/video.mp4?signature=one']},f.options);
    await storage.archivePredictionResult({status:'completed',outputs:['https://cdn.example/video.mp4?signature=two']},f.options);
    assert.equal(f.objects.size,1);assert.equal(f.downloads,1);
});
test('duplicate result aliases and simultaneous polls share one upload', async () => {
    const f = fixture();const data={status:'completed',outputs:['https://cdn.example/video.mp4'],url:'https://cdn.example/video.mp4'};
    const results=await Promise.all([storage.archivePredictionResult(data,f.options),storage.archivePredictionResult(data,f.options)]);
    assert.equal(f.downloads,1);assert.equal(f.objects.size,1);
    assert.equal(results[0].outputs[0],results[0].url);
});
test('different API owners cannot reuse each other’s capability', async () => {
    const a=fixture(),b=fixture();b.options.apiKey='second-owner';
    const data={status:'completed',outputs:['https://cdn.example/video.mp4']};
    assert.notEqual((await storage.archivePredictionResult(data,a.options)).outputs[0],(await storage.archivePredictionResult(data,b.options)).outputs[0]);
});
test('missing auth or disabled storage leaves data unchanged', async () => {
    const data={status:'completed',outputs:['https://cdn.example/video.mp4']};
    assert.strictEqual(await storage.archivePredictionResult(data,{...fixture().options,apiKey:null}),data);
    assert.strictEqual(await storage.archivePredictionResult(data,{...fixture().options,env:{}}),data);
});
test('image or audio responses remain on their original URLs', async () => {
    const f=fixture();f.options.downloadVideo=async()=>null;
    const data={status:'completed',outputs:['https://cdn.example/image.png'],metadata:{url:'https://do-not-touch.example'}};
    assert.deepEqual(await storage.archivePredictionResult(data,f.options),data);assert.equal(f.objects.size,0);
});
test('an archive failure is not returned as a completed stored video', async () => {
    const f=fixture();f.options.store.put=async()=>{throw Error('storage unavailable')};
    await assert.rejects(storage.archivePredictionResult({status:'completed',outputs:['https://cdn.example/video.mp4']},f.options),/storage unavailable/);
});
test('private, credentialed and non-HTTPS video sources are refused', async () => {
    const resolve=async()=>[{address:'93.184.216.34',family:4}];
    for(const url of ['http://cdn.example/video.mp4','https://127.0.0.1/video.mp4','https://[::1]/video.mp4','https://user:pass@cdn.example/v.mp4','https://cdn.example:8443/v.mp4']) {
        await assert.rejects(storage.publicTarget(url,resolve));
    }
    for(const address of ['10.0.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','fc00::1','fe80::1']){
        await assert.rejects(storage.publicTarget('https://cdn.example/v.mp4',async()=>[{address,family:address.includes(':')?6:4}]));
    }
    const target=await storage.publicTarget('https://cdn.example/v.mp4',resolve);assert.equal(target.address.address,'93.184.216.34');
});
test('malformed paths and missing capabilities are refused',()=>{
    for(const key of ['../secret','a/b','a'.repeat(64)+'/../'+'b'.repeat(64)])assert.equal(storage.validCapability(key,'f'.repeat(64),env.VIDEO_STORAGE_SIGNING_SECRET),false);
    assert.equal(storage.validCapability('a'.repeat(64)+'/'+'b'.repeat(64),null,env.VIDEO_STORAGE_SIGNING_SECRET),false);
});
