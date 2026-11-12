// Mounted only by smoke-container.mjs into its disposable CI container.
// Never enabled by the image or production Compose configuration.
import { readFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://container-test.cloudflareaccess.com/cdn-cgi/access/certs') {
        return Response.json(JSON.parse(readFileSync('/qa/jwks.json', 'utf8')));
    }
    if (new URL(url).origin === 'https://api.muapi.ai') {
        const headers = new Headers(init?.headers);
        if (headers.get('x-api-key') !== 'synthetic-container-key') throw new Error('Server key was not injected');
        for (const name of ['cookie', 'authorization', 'cf-access-jwt-assertion']) {
            if (headers.has(name)) throw new Error('Private login header reached provider');
        }
        return Response.json({ balance: 123 });
    }
    return originalFetch(url, init);
};
