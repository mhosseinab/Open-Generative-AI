import { isStaffMode, getStaffIdentity } from '../../../../../src/lib/staffAuth.mjs';
import { NextResponse } from 'next/server';
import videoStorage from '../../../../../src/lib/videoStorage.cjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
    if (isStaffMode()) {
        try { await getStaffIdentity(request); }
        catch (error) { return NextResponse.json({ error: error.message }, { status: error.status || 503 }); }
    }
    const { owner, asset } = await params;
    const key = `${owner}/${asset}`;
    const token = new URL(request.url).searchParams.get('token');
    const settings = videoStorage.config();
    if (!settings) return NextResponse.json({ error: 'Video storage unavailable' }, { status: 503 });
    if (!videoStorage.validCapability(key, token, settings.secret)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    try {
        const store = await videoStorage.s3Store(settings);
        if (!await store.exists(key)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        // The stable capability URL survives browser history; only this S3 URL expires.
        const response = NextResponse.redirect(await store.signedGet(key, request.method), 307);
        response.headers.set('Cache-Control', 'private, no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
    } catch {
        return NextResponse.json({ error: 'Video storage temporarily unavailable' }, { status: 503 });
    }
}

export const HEAD = GET;
