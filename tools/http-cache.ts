// HTTP validators for static files The Signal serves (snapshot and RSS feeds): a strong ETag from
// the bytes, Last-Modified from the document's own build time, and the conditional-request rules
// of RFC 9110 (If-None-Match wins over If-Modified-Since). Used by the local preview server;
// production static hosting supplies its own, and these tests document what readers can expect.
import { createHash } from 'node:crypto';

export const RSS_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function etagOf(body: string | Uint8Array): string {
  return '"' + createHash('sha256').update(body).digest('base64url').slice(0, 32) + '"';
}

/** The <lastBuildDate> of an RSS document, or null. */
export function rssBuildDate(xml: string): Date | null {
  const m = /<lastBuildDate>([^<]{5,64})<\/lastBuildDate>/.exec(xml);
  const t = m ? Date.parse(m[1]!) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

export function isNotModified(headers: Record<string, string | string[] | undefined>, etag: string, lastModified: Date | null): boolean {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);
  const inm = one(headers['if-none-match']);
  if (inm !== undefined) {
    // Weak comparison, as RFC 9110 requires for If-None-Match.
    const bare = etag.replace(/^W\//, '');
    return inm.split(',').map((s) => s.trim()).some((t) => t === '*' || t.replace(/^W\//, '') === bare);
  }
  const ims = one(headers['if-modified-since']);
  if (ims && lastModified) {
    const t = Date.parse(ims);
    if (Number.isFinite(t)) return Math.floor(lastModified.getTime() / 1000) <= Math.floor(t / 1000);
  }
  return false;
}
