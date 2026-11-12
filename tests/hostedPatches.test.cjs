const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyHostedPatches, patches, sourceHash } = require('../scripts/apply-hosted-patches.cjs');
const root = path.resolve(__dirname, '..');

function originalSource(patch) {
    let source = fs.readFileSync(path.join(root, patch.file), 'utf8');
    if (sourceHash(source) === patch.afterHash) {
        for (const [before, after] of [...patch.replacements].reverse()) {
            assert.equal(source.split(after).length, 2);
            source = source.replace(after, before);
        }
    }
    assert.equal(sourceHash(source), patch.beforeHash);
    return source;
}

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-overlay-'));
    for (const patch of patches) {
        const filename = path.join(directory, patch.file);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, originalSource(patch));
    }
    return directory;
}

function parserFrom(directory) {
    const source = fs.readFileSync(path.join(directory, 'packages/Open-Poe-AI/packages/agents/src/AiAgent.jsx'), 'utf8');
    const start = source.indexOf('const parseMessageContent = ') + 'const parseMessageContent = '.length;
    const end = source.indexOf('\n\nconst CopyButton', start);
    return Function(`return (${source.slice(start, end).replace(/;\s*$/, '')})`)();
}

test('pinned embedded uploads are patched reproducibly and a second apply changes nothing', () => {
    const directory = fixture();
    try {
        assert.deepEqual(applyHostedPatches(directory), { changed: 7, checked: 7 });
        assert.deepEqual(applyHostedPatches(directory), { changed: 0, checked: 7 });
        for (const patch of patches) {
            assert.equal(sourceHash(fs.readFileSync(path.join(directory, patch.file), 'utf8')), patch.afterHash);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unexpected upstream changes fail before any embedded source is written', () => {
    const directory = fixture();
    try {
        const first = path.join(directory, patches[0].file);
        const last = path.join(directory, patches.at(-1).file);
        fs.appendFileSync(last, '\n// Unreviewed upstream change\n');
        assert.throws(() => applyHostedPatches(directory), /refuses unknown source/);
        assert.equal(sourceHash(fs.readFileSync(first, 'utf8')), patches[0].beforeHash);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('agent messages render canonical image, video, audio and legacy video links as media', () => {
    const directory = fixture();
    try {
        applyHostedPatches(directory);
        const parse = parserFrom(directory);
        const key = `${'a'.repeat(64)}/${'b'.repeat(64)}`;
        const url = `/api/stored-videos/${key}?token=${'c'.repeat(64)}`;
        for (const type of ['image', 'video', 'audio']) {
            const value = `${url}&type=${type}`;
            assert.deepEqual(parse(value), [{ type, url: value }]);
            assert.deepEqual(parse(`https://studio.example${value}`), [{ type, url: `https://studio.example${value}` }]);
        }
        assert.deepEqual(parse(url), [{ type: 'video', url }]);
        const avif = 'https://provider.example/output.avif?expires=1';
        assert.deepEqual(parse(avif), [{ type: 'image', url: avif }]);
        assert.deepEqual(parse('https://%'), [{ type: 'text', content: 'https://%' }]);
        assert.deepEqual(parse('plain text'), [{ type: 'text', content: 'plain text' }]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
