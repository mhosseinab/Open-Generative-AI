import { isStaffMode, getStaffIdentity, readProviderKey } from '../../../src/lib/staffAuth.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
    const headers = { 'Cache-Control': 'private, no-store' };
    if (!isStaffMode()) return Response.json({ staffMode: false }, { headers });
    try {
        const { email } = await getStaffIdentity(request);
        return Response.json({ staffMode: true, email, providerConfigured: Boolean(await readProviderKey()) }, { headers });
    } catch (error) {
        return Response.json({ error: error.message }, { status: error.status || 503, headers });
    }
}
