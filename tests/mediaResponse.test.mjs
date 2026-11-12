import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { streamStoredMedia } from '../src/lib/mediaResponse.mjs';
import { canonicalMediaKey, translateMediaInputs } from '../src/lib/staffMedia.mjs';
import storage from '../src/lib/videoStorage.cjs';

const key = 'a'.repeat(64) + '/' + 'b'.repeat(64);
const settings = { secret: 'test-secret-'.repeat(4) };
const origin = 'https://studio.example.com';
const canonical = storage.storedUrl(key, settings.secret, 'image/png');
function fixture() {
    return { async get(_key, { method, range }) {
        assert.equal(_key,key);
        if (range === 'bytes=99-') throw { name:'InvalidRange', $metadata:{httpStatusCode:416} };
        const body = range ? 'bc' : 'abcd';
        return { Body: method==='HEAD' ? undefined : Readable.from([Buffer.from(body)]), ContentType:'image/png', ContentLength:body.length, ContentRange:range?'bytes 1-2/4':undefined, ETag:'"fixture"', LastModified:new Date('2026-11-12T00:00:00Z') };
    } };
}
test('persistent media is served directly with content type, no redirect or temporary URL',async()=>{
    const response=await streamStoredMedia(new Request(origin+canonical),key,fixture());
    assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);
    assert.equal(response.headers.get('content-type'),'image/png');assert.equal(await response.text(),'abcd');
});
test('streaming preserves Range, HEAD, cache validation and invalid-range semantics',async()=>{
    let response=await streamStoredMedia(new Request(origin+canonical,{headers:{range:'bytes=1-2'}}),key,fixture());
    assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 1-2/4');assert.equal(await response.text(),'bc');
    response=await streamStoredMedia(new Request(origin+canonical,{method:'HEAD'}),key,fixture());
    assert.equal(response.headers.get('content-length'),'4');assert.equal(await response.text(),'');
    response=await streamStoredMedia(new Request(origin+canonical,{headers:{'if-none-match':'"fixture"'}}),key,fixture());assert.equal(response.status,304);
    response=await streamStoredMedia(new Request(origin+canonical,{headers:{range:'bytes=99-'}}),key,fixture());assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */4');
    response=await streamStoredMedia(new Request(origin+canonical,{headers:{range:'bytes=0-1,3-4'}}),key,fixture());assert.equal(response.status,416);
});
test('only authenticated canonical references are signed for provider inputs, never for browser output',async()=>{
    assert.equal(canonicalMediaKey(canonical,settings,origin),key);
    assert.equal(canonicalMediaKey('https://other.example'+canonical,settings,origin),null);
    assert.throws(()=>canonicalMediaKey(canonical.replace(/token=[a-f0-9]+/,'token=bad'),settings,origin),{status:400});
    let signed=0;
    const store={async signedGet(k,method,ttl){assert.equal(k,key);assert.equal(method,'GET');assert.equal(ttl,3600);signed++;return 'https://s3.example/private?expires=soon';}};
    const output=await translateMediaInputs({image_url:canonical,nodes:[{reference:canonical}],canvas_state:JSON.stringify({source:canonical})},{},{store,settings,origin});
    assert.equal(signed,1);assert.equal(output.image_url,'https://s3.example/private?expires=soon');assert.equal(JSON.parse(output.canvas_state).source,output.image_url);
    assert.equal(canonical.includes('expires='),false);
});
