import { NextResponse } from 'next/server';
import videoStorage from '../../../../../../src/lib/videoStorage.cjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request, { params }) {
    const { requestId } = await params;
    const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!apiKey) return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
    try {
        const upstream = await fetch(`https://api.muapi.ai/api/v1/predictions/${encodeURIComponent(requestId)}/result`, {
            headers: { 'x-api-key': apiKey }, cache: 'no-store',
        });
        const data = await upstream.json();
        const stored = upstream.ok ? await videoStorage.archivePredictionResult(data, { apiKey, requestId }) : data;
        return NextResponse.json(stored, { status: upstream.status, headers: { 'Cache-Control': 'no-store' } });
    } catch {
        return NextResponse.json({ error: 'Generation result or video storage temporarily unavailable; retry' }, { status: 503 });
    }
}
