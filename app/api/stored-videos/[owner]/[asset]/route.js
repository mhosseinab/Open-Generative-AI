import { streamStoredMedia } from '../../../../../src/lib/mediaResponse.mjs';
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
        return await streamStoredMedia(request, key, store);
    } catch {
        return NextResponse.json({ error: 'Video storage temporarily unavailable' }, { status: 503 });
    }
}

export const HEAD = GET;
