// Administrative, read-only MuAPI backfill: never submits a generation request.
const fs = require('node:fs/promises');
const storage = require('../src/lib/videoStorage.cjs');
async function main() {
    if (!storage.config()) throw new Error('Private media storage is not configured');
    const key = process.env.MUAPI_API_KEY_FILE
        ? (await fs.readFile(process.env.MUAPI_API_KEY_FILE, 'utf8')).trim()
        : (process.env.MUAPI_API_KEY || '').trim();
    if (!key) throw new Error('Provider key is not configured');
    const owner = process.env.STAFF_AUTH_MODE === 'cloudflare' ? 'falak-studio-team' : key;
    const get = async path => {
        const response = await fetch('https://api.muapi.ai' + path, {
            headers: { 'x-api-key': key }, cache: 'no-store', signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`Provider history read failed (${response.status})`);
        return response.json();
    };
    let cursor; let archived = 0; let failed = 0; let pending = 0;
    do {
        const query = new URLSearchParams({ limit:'100', ...(cursor ? { cursor } : {}) });
        const history = await get('/api/v1/history?' + query);
        for (const item of history.items || []) {
            if (!['completed','success','succeeded'].includes(String(item.status).toLowerCase())) continue;
            const requestId = item.request_id || item.id;
            try {
                if (await storage.isArchivedResultDeleted(requestId, {apiKey:owner})) continue;
                const cached = await storage.getArchivedResult(requestId, {apiKey:owner});
                if (cached) { archived++; continue; }
                const result = await get('/api/v1/predictions/' + encodeURIComponent(requestId) + '/result');
                if (!['completed','success','succeeded'].includes(String(result.status).toLowerCase())) { pending++; continue; }
                await storage.archivePredictionResult(result, { apiKey:owner, requestId, historyItem:item });
                archived++;
                console.log(JSON.stringify({requestId,model:item.model,status:'archived'}));
            } catch {
                failed++;
                console.log(JSON.stringify({requestId,model:item.model,status:'archive_failed'}));
            }
        }
        cursor = history.next_cursor;
    } while (cursor);
    const catalog = await storage.getMediaCatalog({apiKey:owner});
    console.log(JSON.stringify({archived,failed,pending,savedResults:catalog.items.length,sourceMappings:Object.keys(catalog.links).length}));
    if (failed) process.exitCode = 1;
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
