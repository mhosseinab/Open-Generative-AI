import { Readable } from 'node:stream';

export async function streamStoredMedia(request, key, store) {
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
        return new Response(null, { status: 416, headers: { 'Cache-Control': 'private, no-store' } });
    }
    try {
        const object = await store.get(key, { method: request.method, range });
        const headers = new Headers({ 'Cache-Control': 'private, no-cache', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        if (object.ContentType) headers.set('Content-Type', object.ContentType);
        if (object.ContentLength != null) headers.set('Content-Length', String(object.ContentLength));
        if (object.ContentRange) headers.set('Content-Range', object.ContentRange);
        if (object.ETag) headers.set('ETag', object.ETag);
        if (object.LastModified) headers.set('Last-Modified', object.LastModified.toUTCString());
        // SVG documents must never execute active content on the application's origin.
        headers.set('Content-Disposition', object.ContentType === 'image/svg+xml' ? 'attachment' : 'inline');
        if (!range && object.ETag && request.headers.get('if-none-match') === object.ETag) {
            object.Body?.destroy?.();
            headers.delete('Content-Length');
            return new Response(null, { status: 304, headers });
        }
        const body = request.method === 'HEAD' ? null : object.Body?.transformToWebStream
            ? object.Body.transformToWebStream() : Readable.toWeb(object.Body);
        return new Response(body, { status: object.ContentRange ? 206 : 200, headers });
    } catch (error) {
        const status = error.$metadata?.httpStatusCode;
        if (status === 404 || error.name === 'NoSuchKey') return Response.json({ error: 'Not found' }, { status: 404 });
        if (status === 416 || error.name === 'InvalidRange') {
            const headers = { 'Cache-Control': 'private, no-store' };
            const metadata = await store.get(key, { method: 'HEAD' });
            if (metadata.ContentLength != null) headers['Content-Range'] = `bytes */${metadata.ContentLength}`;
            return new Response(null, { status: 416, headers });
        }
        throw error;
    }
}
