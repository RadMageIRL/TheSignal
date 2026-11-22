// One collection run: fetch feeds within budget, parse, normalize, dedupe, cluster, lay out,
// and return a snapshot plus per-source health. Never throws for a feed failure.
import type { Article, SourceEntry, SourceHealth, Snapshot, FeedEndpoint } from '../shared/types.ts';
import { fetchFeed, runPool, type FetchOptions, type FetchOutcome, type FetchPolicy } from './fetch.ts';
import { parseXmlFeed, parseMastodonLinks, parseWikipediaTop, type ParseResult } from './parse.ts';
import { toArticle, dedupe } from './normalize.ts';
import { clusterArticles } from '../shared/cluster.ts';
import { buildLayout } from '../shared/layout.ts';
import { toPublicSource } from '../shared/registry.ts';
import { DEFAULT_USER_AGENT, userAgentFor } from '../shared/identity.ts';
import { DEFAULT_CONTROLS, type Controls } from './controls.ts';

export type Fetcher = (url: string, policy: FetchPolicy, opts: FetchOptions) => Promise<FetchOutcome>;

export interface RunOptions {
  now: Date;
  userAgent: string;
  mode: Snapshot['mode'];
  concurrency: number;
  perHost: number;
  timeoutMs: number;
  maxBytes: number;
  podcastMaxBytes: number;
  /** Hard wall-clock budget for the whole run; feeds not started by then are skipped. */
  budgetMs: number;
  /** Stop starting new fetches once this many bytes have been read. */
  maxBytesPerRun: number;
  /** At most this many feeds are attempted; the rest are reported as skipped. */
  maxFeeds: number;
  retries: number;
  retryDelayMs: number;
  /** Rolling window: drop articles older than this many hours, per section. */
  maxAgeHours: Record<string, number>;
  /** At most this many of a source's newest articles are kept. */
  perSourceCap: number;
  nextUpdateAt: string | null;
  /** Test seam: replaces the network fetch. */
  fetcher?: Fetcher;
}

export const MAX_AGE_HOURS: Record<string, number> = { us: 48, world: 48, markets: 72, outside: 120, airwaves: 336, pulse: 72 };

export function runOptionsFrom(c: Controls): Omit<RunOptions, 'now' | 'mode' | 'nextUpdateAt'> {
  return {
    userAgent: DEFAULT_USER_AGENT,
    concurrency: c.concurrency,
    perHost: c.perHost,
    timeoutMs: c.timeoutMs,
    maxBytes: c.maxBytesPerResponse,
    podcastMaxBytes: c.podcastMaxBytes,
    budgetMs: c.budgetMs,
    maxBytesPerRun: c.maxBytesPerRun,
    maxFeeds: c.maxFeedsPerRun,
    retries: c.retries,
    retryDelayMs: c.retryDelayMs,
    maxAgeHours: MAX_AGE_HOURS,
    perSourceCap: c.perSourceCap,
  };
}

export const DEFAULT_RUN = runOptionsFrom(DEFAULT_CONTROLS);

export function fillTemplate(url: string, now: Date): string {
  const y = new Date(now.getTime() - 26 * 3600_000);
  return url
    .replace('{Y}', String(y.getUTCFullYear()))
    .replace('{M}', String(y.getUTCMonth() + 1).padStart(2, '0'))
    .replace('{D}', String(y.getUTCDate()).padStart(2, '0'));
}

export function allowlistFor(sources: SourceEntry[], now: Date): Set<string> {
  const hosts = new Set<string>();
  for (const s of sources) for (const f of s.feeds) {
    hosts.add(new URL(fillTemplate(f.url, now)).hostname.toLowerCase());
    for (const h of f.redirectHosts ?? []) hosts.add(h.toLowerCase());
  }
  return hosts;
}

function parseFor(f: FeedEndpoint, body: string, finalUrl: string, now: Date, truncated = false, homepage?: string): ParseResult {
  if (f.kind === 'mastodon-links') return parseMastodonLinks(body, new URL(finalUrl).hostname, now);
  if (f.kind === 'wikipedia-top') return parseWikipediaTop(body, 'en.wikipedia.org', now);
  return parseXmlFeed(body, finalUrl, now, { truncated, linkFallbackToChannel: f.kind === 'podcast', fallbackLink: homepage });
}

/** True when the URL's path starts with one of the excluded prefixes (case-insensitive). */
export function excludedPath(url: string, prefixes: string[]): boolean {
  let path: string;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return true; }
  return prefixes.some((p) => path.startsWith(p.toLowerCase()));
}

/** Errors worth one more attempt: network failures and server errors, never policy refusals or 4xx. */
export function retryable(r: FetchOutcome): boolean {
  return !r.ok && (r.status >= 500 || r.status === 0) && !/allowlist|private|scheme|raw IP|over \d+ bytes/.test(r.error ?? '');
}

export async function collect(sources: SourceEntry[], opts: RunOptions): Promise<{ snapshot: Snapshot; health: SourceHealth[] }> {
  const started = Date.now();
  const nowIso = opts.now.toISOString();
  const fetcher = opts.fetcher ?? fetchFeed;
  const policy: FetchPolicy = {
    allowHosts: allowlistFor(sources, opts.now),
    userAgent: opts.userAgent,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
  };
  // Podcast feeds can run to many megabytes of back catalog; the newest episodes are at the top.
  const podcastPolicy: FetchPolicy = { ...policy, maxBytes: Math.min(policy.maxBytes, opts.podcastMaxBytes) };
  const all = sources.flatMap((s) => s.feeds.map((f) => ({ s, f, url: fillTemplate(f.url, opts.now) })));
  // Frequent feeds first, so a feed cap never starves the fastest-moving news.
  all.sort((a, b) => a.s.intervalMinutes - b.s.intervalMinutes || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0));
  const tasks = all.slice(0, opts.maxFeeds);
  const perSource = new Map<string, { items: Article[]; errors: string[]; okFeeds: number }>();
  const rec = (id: string) => {
    let r = perSource.get(id);
    if (!r) perSource.set(id, (r = { items: [], errors: [], okFeeds: 0 }));
    return r;
  };
  for (const t of all.slice(opts.maxFeeds)) rec(t.s.id).errors.push('skipped: feed cap for this run');
  let bytes = 0;

  await runPool(
    tasks,
    (t) => new URL(t.url).hostname,
    async ({ s, f, url }) => {
      const r0 = rec(s.id);
      if (Date.now() - started > opts.budgetMs) { r0.errors.push('skipped: run budget spent'); return; }
      if (bytes >= opts.maxBytesPerRun) { r0.errors.push('skipped: run byte budget spent'); return; }
      const fo = { allowTruncate: f.kind === 'podcast', userAgent: userAgentFor(s.id) };
      const pol = f.kind === 'podcast' ? podcastPolicy : policy;
      let r = await fetcher(url, pol, fo);
      bytes += r.bytes;
      for (let attempt = 0; attempt < opts.retries && retryable(r); attempt++) {
        if (opts.retryDelayMs > 0) await new Promise((res) => setTimeout(res, opts.retryDelayMs));
        r = await fetcher(url, pol, fo);
        bytes += r.bytes;
      }
      if (!r.ok) { r0.errors.push(r.error ?? `HTTP ${r.status}`); return; }
      const p = parseFor(f, r.body, r.finalUrl, opts.now, r.truncated, s.homepage);
      if (p.items.length === 0) { r0.errors.push(p.problems[0] ?? 'no items'); return; }
      r0.okFeeds++;
      const drop = new Set((s.filters?.dropWires ?? []).map((w) => w.toLowerCase()));
      const paths = s.filters?.excludePaths ?? [];
      for (const it of p.items) {
        const a = toArticle(it, s, f, nowIso);
        if (a.wire && drop.has(a.wire.toLowerCase())) continue;
        if (paths.length > 0 && excludedPath(a.url, paths)) continue;
        r0.items.push(a);
      }
    },
    opts.concurrency,
    opts.perHost,
  );

  const kept0: Article[] = [];
  const health: SourceHealth[] = [];
  for (const s of sources) {
    const r = perSource.get(s.id) ?? { items: [], errors: ['not attempted'], okFeeds: 0 };
    const cutoff = opts.now.getTime() - (opts.maxAgeHours[s.section] ?? 48) * 3600_000;
    const items = r.items
      .filter((a) => Date.parse(a.publishedAt ?? a.fetchedAt) >= cutoff)
      .sort((x, y) => Date.parse(y.publishedAt ?? y.fetchedAt) - Date.parse(x.publishedAt ?? x.fetchedAt))
      .slice(0, opts.perSourceCap);
    kept0.push(...items);
    const newest = Math.max(0, ...r.items.map((a) => Date.parse(a.publishedAt ?? '') || 0));
    const stale = newest > 0 && opts.now.getTime() - newest > 7 * 24 * 3600_000;
    const skipped = r.okFeeds === 0 && r.errors.length > 0 && r.errors.every((e) => e.startsWith('skipped'));
    health.push({
      sourceId: s.id,
      ok: r.okFeeds > 0,
      status: r.okFeeds > 0 ? (stale ? 'stale' : 'fresh') : skipped ? 'skipped' : 'failed',
      items: items.length,
      lastAttempt: nowIso,
      lastSuccess: r.okFeeds > 0 ? nowIso : undefined,
      error: r.errors[0],
    });
  }

  const snapshot = assembleSnapshot(sources, kept0, { now: opts.now, mode: opts.mode, nextUpdateAt: opts.nextUpdateAt }, {
    sourcesOk: health.filter((h) => h.ok).length,
    durationMs: Date.now() - started,
    bytesFetched: bytes,
  });
  return { snapshot, health };
}

/**
 * Everything after fetching: dedupe, cluster, rank, lay out and package the snapshot. Pure, so
 * fixtures and tests run exactly the code a live collection runs.
 */
export function assembleSnapshot(
  sources: SourceEntry[],
  collected: Article[],
  run: { now: Date; mode: Snapshot['mode']; nextUpdateAt: string | null },
  measured: { sourcesOk: number; durationMs: number; bytesFetched: number },
): Snapshot {
  const { kept, removed } = dedupe(collected);
  // Podcasts and community items are listed individually and never grouped into stories.
  const clusters = clusterArticles(kept.filter((a) => a.section !== 'airwaves' && a.section !== 'pulse'));
  const byId = new Map(kept.map((a) => [a.id, a] as const));
  const page = buildLayout(byId, clusters, run.now.getTime());
  return {
    schema: 1,
    mode: run.mode,
    generatedAt: run.now.toISOString(),
    nextUpdateAt: run.nextUpdateAt,
    sources: sources.map(toPublicSource),
    articles: kept,
    clusters: [...page.clusters.values()],
    leadClusterId: page.leadClusterId,
    layout: page.layout,
    perspectives: page.perspectives,
    trending: page.trending,
    breaking: page.breaking,
    stats: {
      sourcesAttempted: sources.length,
      sourcesOk: measured.sourcesOk,
      articlesCollected: collected.length,
      duplicatesRemoved: removed,
      clustersFormed: clusters.length,
      multiSourceClusters: clusters.filter((c) => c.sourceCount >= 2).length,
      durationMs: measured.durationMs,
      bytesFetched: measured.bytesFetched,
    },
  };
}
