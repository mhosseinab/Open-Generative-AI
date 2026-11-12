import { NextResponse } from 'next/server';
import { getLocaleFromPathname } from './lib/locales';

function addSecurityHeaders(response) {
    // Exact private-storage origin; bucket CORS also permits only this app.
    const storageOrigin = process.env.VIDEO_STORAGE_ENDPOINT ? new URL(process.env.VIDEO_STORAGE_ENDPOINT).origin : '';
    // Prevent MIME type sniffing (CWE-693)
    response.headers.set('X-Content-Type-Options', 'nosniff');
    // Prevent clickjacking (CWE-1021)
    response.headers.set('X-Frame-Options', 'DENY');
    // Enable XSS filter in legacy browsers
    response.headers.set('X-XSS-Protection', '1; mode=block');
    // Referrer policy
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Content Security Policy - restricts script sources to prevent XSS (CWE-79).
    // connect-src covers *.muapi.ai (not just api.muapi.ai) because generated
    // media, model thumbnails, and other assets are served from cdn.muapi.ai
    // and other muapi subdomains that the renderer fetches directly.
    response.headers.set(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' https://muapi.ai https://*.muapi.ai ${storageOrigin}; font-src 'self' data:;`
    );
    return response;
}

export function middleware(request) {
    const url = request.nextUrl;

    // Staff requests always use the verified, server-key proxy, never external rewrites.
    if (process.env.STAFF_AUTH_MODE === 'cloudflare' && url.pathname.startsWith('/api/')) {
        const local = ['/api/staff-session', '/api/staff-proxy', '/api/upload-binary', '/api/v1/upload-binary'];
        if (!local.includes(url.pathname) && !url.pathname.startsWith('/api/stored-videos/')) {
            const target = url.clone();
            target.searchParams.set('__studio_path', url.pathname);
            target.pathname = '/api/staff-proxy';
            const headers = new Headers(request.headers);
            headers.set('x-studio-api-path', url.pathname);
            return addSecurityHeaders(NextResponse.rewrite(target, { request: { headers } }));
        }
        return addSecurityHeaders(NextResponse.next());
    }

    // Catch requests to /api/workflow, /api/app, and /api/v1
    const isMuApi = url.pathname.startsWith('/api/workflow') ||
                    url.pathname.startsWith('/api/app') ||
                    url.pathname.startsWith('/api/v1');

    if (isMuApi) {
        // Exclude paths that have their own dedicated route handlers with custom logic
        const isHandledByRoute = /^\/api\/v1\/predictions\/[^/]+\/result$/.test(url.pathname) ||
                                url.pathname.startsWith('/api/v1/creative-agent') ||
                                url.pathname.startsWith('/api/v1/get_upload_url') ||
                                url.pathname.startsWith('/api/v1/upload-binary');

        if (url.pathname.startsWith('/api/v1') && !isHandledByRoute) {
            const targetUrl = new URL(url.pathname + url.search, 'https://api.muapi.ai');
            const rewriteResponse = NextResponse.rewrite(targetUrl);
            return addSecurityHeaders(rewriteResponse);
        }
    }

    // Plain response header carrying the locale derived from the URL path
    // (same "set in middleware, read via headers() in the root layout"
    // trick the main muapi client uses — see docs/localization.md).
    const response = NextResponse.next();
    response.headers.set('x-locale', getLocaleFromPathname(url.pathname));
    return addSecurityHeaders(response);
}

// Match all paths for security headers. Exclude Next.js internal paths.
export const config = {
    matcher: [
        '/api/:path*',
        '/((?!_next/static|_next/image|favicon.ico|__nextjs_original-stack-frame).*)',
    ],
};
