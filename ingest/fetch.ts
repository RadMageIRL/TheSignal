// Bounded, allowlisted HTTP fetching for the ingestion job.
// - Only hosts named in the source registry (plus declared redirect hosts) are ever fetched.
// - Every hop's address is resolved and private, loopback and link-local ranges are refused.
// - Redirects are followed manually (max 3), each hop re-checked.
// - Responses are size-capped while streaming and time-capped with an abort signal.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface FetchPolicy {
  allowHosts: Set<string>;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  /** Test seam: replaces the DNS lookup used for the private-address check. */
  resolve?: (host: string) => Promise<{ address: string }[]>;
  /** Told about every request actually sent, redirect hops included (the operations log's request ledger). */
  observe?: (e: RequestEvent) => void;
  /** Clock for RequestEvent.sentAt (default Date.now), so pacing and the ledger share one time base. */
  now?: () => number;
}

/**
 * One HTTP request: reported once as it is sent ("sent") and once when it ends ("done"). `url` is
 * the request the fetch started with, `target` this hop's URL.
 */
export interface RequestEvent {
  phase: 'sent' | 'done';
  url: string;
  target: string;
  hop: number;
  /** When the request was sent (policy.now, default Date.now). */
  sentAt: number;
  userAgent: string;
  /** "done" only: HTTP status, or 0 for a network error or timeout. */
  status?: number;
  ms?: number;
  error?: string;
}

export interface FetchOptions {
  etag?: string;
  lastModified?: string;
  /** Keep the first maxBytes of an oversized response (very long podcast feeds) instead of failing. */
  allowTruncate?: boolean;
  /** Source-specific User-Agent (see shared/identity.ts); defaults to the policy's. */
  userAgent?: string;
  /**
   * Asked before a redirect is followed, with the next hop's URL; a non-null answer stops the
   * fetch with that reason before anything is requested from the new location. The collector
   * uses it to evaluate robots.txt for every hop (see ingest/robots.ts).
   */
  permitRedirect?: (next: URL) => Promise<string | null>;
}

export type Fetcher = (url: string, policy: FetchPolicy, opts: FetchOptions) => Promise<FetchOutcome>;

export interface FetchOutcome {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  notModified: boolean;
  body: string;
  bytes: number;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  /** The Retry-After header, when the answer had one. */
  retryAfter?: string;
  ms: number;
  truncated?: boolean;
  error?: string;
}

function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = addr.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
    || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

export async function checkHost(url: URL, policy: FetchPolicy): Promise<string | null> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'scheme not allowed';
  const host = url.hostname.toLowerCase();
  if (!policy.allowHosts.has(host)) return `host not on allowlist: ${host}`;
  if (isIP(host)) return 'raw IP hosts are not allowed';
  try {
    const addrs = policy.resolve ? await policy.resolve(host) : await lookup(host, { all: true });
    if (addrs.length === 0) return 'no address';
    if (addrs.some((a) => isPrivateAddress(a.address))) return 'resolves to a private address';
  } catch {
    return 'dns lookup failed';
  }
  return null;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', bytes: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  // Respect a declared charset when it is not UTF-8 (a few feeds still send ISO-8859-1).
  const ct = res.headers.get('content-type') ?? '';
  const m = /charset=([\w-]+)/i.exec(ct);
  let label = m?.[1]?.toLowerCase() ?? 'utf-8';
  if (!m) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 200));
    const x = /encoding=["']([\w-]+)["']/i.exec(head);
    if (x?.[1]) label = x[1].toLowerCase();
  }
  let text: string;
  try { text = new TextDecoder(label).decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); }
  return { text, bytes, truncated };
}

export async function fetchFeed(
  url: string,
  policy: FetchPolicy,
  validators: FetchOptions = {},
): Promise<FetchOutcome> {
  const started = Date.now();
  const base: FetchOutcome = { url, finalUrl: url, status: 0, ok: false, notModified: false, body: '', bytes: 0, ms: 0 };
  let current = new URL(url);
  const signal = AbortSignal.timeout(policy.timeoutMs);
  const clock = policy.now ?? Date.now;
  let inFlight: { target: string; hop: number; sentAt: number; userAgent: string } | null = null;
  const seen = (status: number, error?: string) => {
    if (!inFlight) return;
    policy.observe?.({ phase: 'done', url, ...inFlight, status, ms: clock() - inFlight.sentAt, error });
    inFlight = null;
  };
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const bad = await checkHost(current, policy);
      if (bad) return { ...base, finalUrl: current.toString(), error: bad, ms: Date.now() - started };
      if (hop > 0 && validators.permitRedirect) {
        const refused = await validators.permitRedirect(current);
        if (refused) return { ...base, finalUrl: current.toString(), error: refused, ms: Date.now() - started };
      }
      const headers: Record<string, string> = {
        'user-agent': validators.userAgent ?? policy.userAgent,
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5',
      };
      if (hop === 0 && validators.etag) headers['if-none-match'] = validators.etag;
      if (hop === 0 && validators.lastModified) headers['if-modified-since'] = validators.lastModified;
      inFlight = { target: current.toString(), hop, sentAt: clock(), userAgent: headers['user-agent']! };
      policy.observe?.({ phase: 'sent', url, ...inFlight });
      const res = await fetch(current, { headers, redirect: 'manual', signal });
      seen(res.status);
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc) return { ...base, status: res.status, error: 'redirect without location', ms: Date.now() - started };
        current = new URL(loc, current);
        continue;
      }
      const common = {
        finalUrl: current.toString(),
        status: res.status,
        etag: res.headers.get('etag') ?? undefined,
        lastModified: res.headers.get('last-modified') ?? undefined,
        contentType: res.headers.get('content-type') ?? undefined,
        retryAfter: res.headers.get('retry-after') ?? undefined,
      };
      if (res.status === 304) {
        await res.body?.cancel();
        return { ...base, ...common, ok: true, notModified: true, ms: Date.now() - started };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ...base, ...common, error: `HTTP ${res.status}`, ms: Date.now() - started };
      }
      const { text, bytes, truncated } = await readCapped(res, policy.maxBytes);
      if (truncated && !validators.allowTruncate) return { ...base, ...common, bytes, error: `response over ${policy.maxBytes} bytes`, ms: Date.now() - started };
      return { ...base, ...common, ok: true, body: text, bytes, truncated, ms: Date.now() - started };
    }
    return { ...base, error: 'too many redirects', ms: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message) : 'fetch failed';
    seen(0, msg.slice(0, 160));
    return { ...base, finalUrl: current.toString(), error: msg.slice(0, 160), ms: Date.now() - started };
  }
}

/** Errors worth one more attempt: network failures and server errors, never policy refusals or 4xx. */
export function retryable(r: FetchOutcome): boolean {
  return !r.ok && (r.status >= 500 || r.status === 0) && !/allowlist|private|scheme|raw IP|over \d+ bytes|robots\.txt/.test(r.error ?? '');
}

/** Run tasks with a global concurrency limit and a per-host limit. */
export async function runPool<T, R>(
  tasks: T[],
  hostOfTask: (t: T) => string,
  worker: (t: T) => Promise<R>,
  concurrency: number,
  perHost: number,
): Promise<R[]> {
  const results: R[] = new Array(tasks.length);
  const active = new Map<string, number>();
  const pending = tasks.map((t, i) => ({ t, i }));
  let running = 0;
  return new Promise((resolve) => {
    const pump = () => {
      if (pending.length === 0 && running === 0) return resolve(results);
      for (let k = 0; k < pending.length && running < concurrency; ) {
        const job = pending[k]!;
        const h = hostOfTask(job.t);
        if ((active.get(h) ?? 0) >= perHost) { k++; continue; }
        pending.splice(k, 1);
        running++;
        active.set(h, (active.get(h) ?? 0) + 1);
        worker(job.t)
          .then((r) => { results[job.i] = r; })
          .catch(() => { /* worker reports its own errors */ })
          .finally(() => {
            running--;
            active.set(h, (active.get(h) ?? 1) - 1);
            pump();
          });
      }
    };
    pump();
  });
}
