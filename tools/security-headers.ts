// Security headers for the public site. The same set is served by the local preview (so the
// browser tests run under the production policy) and written into vercel.json at deploy time.
// The page loads nothing from other origins; its one inline script (the theme, applied before
// first paint) is allowed by hash, so no 'unsafe-inline' is needed.
import { createHash } from 'node:crypto';

/** sha256 sources for every inline <script> (one without a src attribute) in the HTML. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    out.push(`'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
  }
  return out;
}

export function securityHeaders(indexHtml: string): Record<string, string> {
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${inlineScriptHashes(indexHtml).join(' ')}`.trim(),
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  };
}
