// URL validation and canonicalization for outbound article links.

// Tracking parameters that never change which article a URL points to.
const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'cmpid', 'cmp', 'ocid', 'smid', 'smtyp',
  'ito', 'taid', 'guce_referrer', 'guce_referrer_sig', 'guccounter', 'traffic_source', 'ref_src',
  'feedtype', 'xtor', 'ns_mchannel', 'ns_source', 'ns_campaign', 'ns_linkname', 'ns_fee', 'cid_source',
  'rss', 'rssfeed', 'from_rss', 'source_rss', 'sr_share', 'share', 'via', 'ftag', 'emc', 'partner',
]);
const TRACKING_PREFIX = ['utm_', 'at_', 'pk_', 'mtm_', 'itm_', 'sc_', 'hsa_', '__'];

/**
 * Returns a safe absolute http(s) URL string, or null. Rejects other schemes, embedded
 * credentials, raw IP hosts and hosts without a dot (intranet names).
 */
export function safeLink(raw: unknown, base?: string): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  let u: URL;
  try {
    u = base ? new URL(s, base) : new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  return u.toString();
}

/** Canonical form used for deduplication only (the displayed link keeps the publisher's URL). */
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^(www\d?|m|amp|mobile)\./, '');
  u.protocol = 'https:';
  if ((u.port === '443') || (u.port === '80')) u.port = '';
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (TRACKING_EXACT.has(lk)) continue;
    if (TRACKING_PREFIX.some((p) => lk.startsWith(p))) continue;
    keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/amp\/?$/i, '/').replace(/\/index\.html?$/i, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path;
  return u.toString();
}

/** Registrable-ish host used for the per-publisher cap and redirect checks. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch {
    return '';
  }
}
