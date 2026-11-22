// One collection run: decide which feeds are due, fetch them within budget, parse, normalize,
// dedupe, cluster, lay out, and return a snapshot plus per-source health. Never throws for a feed
// failure.
//
// With saved state (ingest/state.ts) a run requests only the feeds whose interval has passed,
// sends conditional requests, backs off after failures, leaves alone an origin that answered 419
// or 429, and shows the stored items of every feed it did not need to request. Without state
// (one-off captures, most tests) every feed is due and every item is first seen now.
import type { Article, SourceEntry, SourceHealth, Snapshot, FeedEndpoint } from '../shared/types.ts';
import { fetchFeed, retryable, runPool, type Fetcher, type FetchOptions, type FetchPolicy, type RequestEvent } from './fetch.ts';
import { parseXmlFeed, parseMastodonLinks, parseWikipediaTop, type ParseResult } from './parse.ts';
import { toArticle, dedupe } from './normalize.ts';
import { clusterArticles } from '../shared/cluster.ts';
import { buildLayout } from '../shared/layout.ts';
import { toPublicSource } from '../shared/registry.ts';
import { DEFAULT_USER_AGENT, ROBOTS_TOKEN, userAgentFor } from '../shared/identity.ts';
import { DEFAULT_CONTROLS, type Controls } from './controls.ts';
import { CRAWL_DELAY_MAX_WAIT_MS, createRobotsGate, type RobotsCacheEntry } from './robots.ts';
import { isEnglish } from '../shared/languages.ts';
import { isSponsored } from '../shared/editorial.ts';
import {
  CARRY_MS, COOL_DOWN_MS, DATE_SKEW_MS, DUE_WAIT_MS, MAX_STORED_ITEMS, RETRY_AFTER_MAX_MS,
  backoffMs, earliestRequest, feedKey, retryAfterMs, type CollectorState, type FeedState,
} from './state.ts';

export type { Fetcher };
export { retryable };

/** Requests and bytes a run cost, for the operations log and the usage measurements. */
export interface RunTraffic {
  feedRequests: number;
  robotsRequests: number;
  /** Feed requests refused by robots.txt (never sent). */
  robotsRefusals: number;
  /** Requests put off to a later run because the origin's Crawl-delay is longer than a run may wait. */
  crawlDelayDeferrals: number;
  /** Feeds not requested because their interval has not passed (their stored items are shown). */
  notDue: number;
  /** Conditional requests answered 304 Not Modified. */
  notModified: number;
  /** Feeds not requested because their origin answered 419 or 429 and is being left alone. */
  coolDownSkips: number;
  bytes: number;
}

/** What happened to one feed in one run, for the operations log. */
export interface FeedReport {
  sourceId: string;
  /** The registry URL (templates unfilled). */
  feed: string;
  outcome: 'fetched' | 'not-modified' | 'not-due' | 'failed' | 'skipped';
  /** Requests sent for this feed (retries included, robots.txt and redirect hops not). */
  requests: number;
  /** Bytes read for this feed (decompressed). */
  bytes: number;
  status?: number;
  /** Waited inside the run for the feed's interval or the origin's Crawl-delay. */
  waitedMs: number;
  /** Items this feed put on the page (fresh or stored). */
  items: number;
  /** Items first seen in this run. */
  firstSeen: number;
  /** Items without a believable publication time (aged by first-seen time). */
  undated: number;
  error?: string;
  nextRequestAt?: string;
}

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
  /** Test seam: replaces the network fetch (robots.txt requests go through it too). */
  fetcher?: Fetcher;
  /** Saved collector state; read and updated in place. Without it every feed is due. */
  state?: CollectorState;
  /** robots.txt answers kept between runs (at most 24 hours old); updated in place. Defaults to the state's. */
  robotsCache?: Map<string, RobotsCacheEntry>;
  /** Told about every request sent (the request ledger). */
  observe?: (e: RequestEvent) => void;
  /** Test seams for scheduling and Crawl-delay pacing (both default to the real clock). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

export interface PlannedFeed { s: SourceEntry; f: FeedEndpoint; url: string; key: string; earliest: number }

/**
 * Which feeds this run may request: those whose interval (and any backoff) has passed, or will
 * within DUE_WAIT_MS. Overdue feeds first, then the most frequent, so a feed cap never starves
 * fast-moving news.
 */
export function planRun(sources: SourceEntry[], state: CollectorState | undefined, nowMs: number, now: Date): { due: PlannedFeed[]; notDue: PlannedFeed[] } {
  const all: PlannedFeed[] = sources.flatMap((s) => s.feeds.map((f) => {
    const key = feedKey(s.id, f.url);
    return { s, f, url: fillTemplate(f.url, now), key, earliest: earliestRequest(state?.feeds[key], s.intervalMinutes) };
  }));
  const due = all.filter((t) => t.earliest <= nowMs + DUE_WAIT_MS);
  due.sort((a, b) => (a.earliest === b.earliest ? 0 : a.earliest - b.earliest)
    || a.s.intervalMinutes - b.s.intervalMinutes || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0));
  return { due, notDue: all.filter((t) => !(t.earliest <= nowMs + DUE_WAIT_MS)) };
}

/** The latest moment (ms after the start) a run with these options could still send a request. */
export function latestRequestOffsetMs(o: Pick<RunOptions, 'budgetMs' | 'retries' | 'timeoutMs' | 'retryDelayMs'>): number {
  return o.budgetMs + DUE_WAIT_MS + CRAWL_DELAY_MAX_WAIT_MS
    + (1 + o.retries) * (o.timeoutMs + o.retryDelayMs + CRAWL_DELAY_MAX_WAIT_MS) + 60_000;
}

/**
 * Gives each freshly fetched item its first-seen time (kept across runs) and keeps its feed date
 * only when the date is not later than that first sighting: a feed that re-dates its items on
 * every request cannot make an old item look new.
 */
export function stampFirstSeen(items: Article[], seen: CollectorState['seen'], nowIso: string): Article[] {
  return items.map((a) => {
    const first = seen[a.id]?.f ?? nowIso;
    seen[a.id] = { f: first, l: nowIso };
    const believable = a.publishedAt !== null && Date.parse(a.publishedAt) <= Date.parse(first) + DATE_SKEW_MS;
    return { ...a, firstSeenAt: first, publishedAt: believable ? a.publishedAt : null };
  });
}

const itemTime = (a: Article) => Date.parse(a.publishedAt ?? a.firstSeenAt);
const iso = (ms: number) => new Date(ms).toISOString();

interface FeedRun {
  outcome: FeedReport['outcome'];
  requests: number;
  bytes?: number;
  waitedMs: number;
  lastSentAt?: number;
  status?: number;
  retryAfter?: string;
  retryable?: boolean;
  robotsRefused?: boolean;
  /** robots.txt gave no usable answer (unreachable, server error, refused redirect): back off before asking again. */
  robotsUnusable?: boolean;
  error?: string;
  fresh?: Article[];
  etag?: string;
  lastModified?: string;
}

export async function collect(sources: SourceEntry[], opts: RunOptions): Promise<{ snapshot: Snapshot; health: SourceHealth[]; traffic: RunTraffic; feeds: FeedReport[] }> {
  const started = Date.now();
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const nowIso = opts.now.toISOString();
  const state = opts.state;
  const hostTimes = new Map<string, number>();
  /** Per request URL, when its latest first hop actually left (after DNS), so schedules count from real send times. */
  const sentAt = new Map<string, number>();
  const policy: FetchPolicy = {
    allowHosts: allowlistFor(sources, opts.now),
    userAgent: opts.userAgent,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    now: clock,
    // Every request actually sent moves its origin's last-request time forward, so Crawl-delay
    // pacing counts from real send times, redirect hops included.
    observe: (e) => {
      const origin = new URL(e.target).origin;
      hostTimes.set(origin, Math.max(hostTimes.get(origin) ?? -Infinity, e.sentAt));
      if (e.phase === 'sent' && e.hop === 0) sentAt.set(e.url, Math.max(sentAt.get(e.url) ?? -Infinity, e.sentAt));
      opts.observe?.(e);
    },
  };
  // Podcast feeds can run to many megabytes of back catalog; the newest episodes are at the top.
  const podcastPolicy: FetchPolicy = { ...policy, maxBytes: Math.min(policy.maxBytes, opts.podcastMaxBytes) };

  const seen: CollectorState['seen'] = state?.seen ?? {};
  const hosts: CollectorState['hosts'] = state?.hosts ?? {};
  const coolingUntil = (origin: string) => Date.parse(hosts[origin]?.coolDownUntil ?? '') || -Infinity;
  const network = opts.fetcher ?? fetchFeed;
  // Any 419 or 429, from a feed or a robots.txt request, starts a cool-down for that origin.
  const fetcher: Fetcher = async (url, pol, fo) => {
    const r = await network(url, pol, fo);
    if (r.status === 419 || r.status === 429) {
      const origin = new URL(r.finalUrl).origin;
      const asked = retryAfterMs(r.retryAfter, clock()) ?? 0;
      hosts[origin] = {
        ...hosts[origin],
        coolDownUntil: iso(clock() + Math.min(RETRY_AFTER_MAX_MS, Math.max(COOL_DOWN_MS, asked))),
        coolDownReason: `HTTP ${r.status} at ${iso(clock())}`,
      };
    }
    return r;
  };

  for (const [o, h] of Object.entries(hosts)) if (h.lastRequestAt) hostTimes.set(o, Date.parse(h.lastRequestAt));
  const robotsCache = opts.robotsCache ?? (state ? new Map(Object.entries(state.robots)) : undefined);
  // robots.txt is evaluated before every request for publisher content, including each redirect
  // hop. There is deliberately no control that turns this off.
  const robots = createRobotsGate(fetcher, policy, {
    now: opts.now, token: ROBOTS_TOKEN, cache: robotsCache, attempts: 1 + opts.retries, clock, sleep, hostTimes,
  });

  const { due, notDue } = planRun(sources, state, clock(), opts.now);
  const tasks = due.slice(0, opts.maxFeeds);
  const runs = new Map<string, FeedRun>();
  for (const t of due.slice(opts.maxFeeds)) runs.set(t.key, { outcome: 'skipped', requests: 0, waitedMs: 0, error: 'skipped: feed cap for this run' });
  for (const t of notDue) runs.set(t.key, { outcome: 'not-due', requests: 0, waitedMs: 0 });
  let bytes = 0;
  let feedRequests = 0;
  let coolDownSkips = 0;
  const spent = () => bytes + robots.stats.bytes;

  await runPool(
    tasks,
    (t) => new URL(t.url).hostname,
    async (t) => {
      const fr: FeedRun = { outcome: 'skipped', requests: 0, waitedMs: 0 };
      runs.set(t.key, fr);
      const stop = (outcome: FeedRun['outcome'], error: string) => { fr.outcome = outcome; fr.error = error; };
      if (Date.now() - started > opts.budgetMs) return stop('skipped', 'skipped: run budget spent');
      if (spent() >= opts.maxBytesPerRun) return stop('skipped', 'skipped: run byte budget spent');
      const origin = new URL(t.url).origin;
      if (coolingUntil(origin) > clock()) {
        coolDownSkips++;
        return stop('skipped', `skipped: ${origin} answered ${hosts[origin]!.coolDownReason}; left alone until ${hosts[origin]!.coolDownUntil}`);
      }
      // The feed's own interval is never cut short: a feed that falls due during the run is waited for.
      const wait = t.earliest - clock();
      if (wait > DUE_WAIT_MS) return stop('not-due', `not due until ${iso(t.earliest)}`);
      if (wait > 0) { await sleep(wait); fr.waitedMs += wait; }
      const userAgent = userAgentFor(t.s.id);
      const verdict = await robots.check(t.url, userAgent);
      if (!verdict.allowed) {
        const deferredRead = verdict.reason!.startsWith('skipped');
        fr.robotsRefused = !deferredRead;
        fr.robotsUnusable = !deferredRead && verdict.basis === 'unreachable';
        return stop(deferredRead ? 'skipped' : 'failed', verdict.reason!);
      }
      const stored: FeedState | undefined = state?.feeds[t.key];
      const conditional = stored !== undefined && stored.items.length > 0;
      const fo: FetchOptions = {
        allowTruncate: t.f.kind === 'podcast',
        userAgent,
        etag: conditional ? stored.etag : undefined,
        lastModified: conditional ? stored.lastModified : undefined,
        permitRedirect: async (next) => {
          if (coolingUntil(next.origin) > clock()) return `skipped: redirect to ${next.origin}, which is being left alone`;
          return (await robots.check(next.toString(), userAgent)).reason ?? (await robots.pace(next.toString(), userAgent));
        },
      };
      const pol = t.f.kind === 'podcast' ? podcastPolicy : policy;
      let deferred: string | null = null;
      const send = async () => {
        // Every request waits out the origin's Crawl-delay, or is deferred to a later run.
        const before = clock();
        deferred = await robots.pace(t.url, userAgent);
        fr.waitedMs += clock() - before;
        if (deferred) return null;
        fr.lastSentAt = clock();
        fr.requests++;
        feedRequests++;
        const r = await fetcher(t.url, pol, fo);
        // The request left after the DNS check: keep the later, real send time when the network layer reported it.
        fr.lastSentAt = Math.max(fr.lastSentAt, sentAt.get(t.url) ?? -Infinity);
        bytes += r.bytes;
        fr.bytes = (fr.bytes ?? 0) + r.bytes;
        return r;
      };
      let r = await send();
      if (!r) return stop('skipped', deferred ?? 'skipped: deferred to a later run');
      for (let attempt = 0; attempt < opts.retries && retryable(r); attempt++) {
        if (opts.retryDelayMs > 0) await sleep(opts.retryDelayMs);
        const again = await send();
        if (!again) break;
        r = again;
      }
      fr.status = r.status;
      if (!r.ok) {
        fr.retryable = retryable(r);
        fr.retryAfter = r.retryAfter;
        return stop('failed', r.error ?? `HTTP ${r.status}`);
      }
      if (r.notModified) {
        if (!conditional) return stop('failed', 'HTTP 304 to a request that sent no validators');
        fr.outcome = 'not-modified';
        fr.etag = r.etag ?? stored.etag;
        fr.lastModified = r.lastModified ?? stored.lastModified;
        return;
      }
      const p = parseFor(t.f, r.body, r.finalUrl, opts.now, r.truncated, t.s.homepage);
      if (p.items.length === 0) return stop('failed', p.problems[0] ?? 'no items');
      fr.outcome = 'fetched';
      fr.fresh = p.items.map((it) => toArticle(it, t.s, t.f, nowIso));
      fr.etag = r.etag;
      fr.lastModified = r.lastModified;
    },
    opts.concurrency,
    opts.perHost,
  );

  // Fold each feed's result into its saved state, and choose the items it shows.
  const tEnd = clock();
  const reports: FeedReport[] = [];
  const perSource = new Map<string, { items: Article[]; reports: FeedReport[]; answering: boolean; lastSuccess?: string }>();
  for (const t of [...due, ...notDue]) {
    const fr = runs.get(t.key)!;
    const interval = t.s.intervalMinutes * 60_000;
    const fs: FeedState = state ? (state.feeds[t.key] ??= { failures: 0, items: [] }) : { failures: 0, items: [] };
    const window = (opts.maxAgeHours[t.s.section] ?? 48) * 3600_000;
    if (fr.lastSentAt !== undefined) {
      fs.lastRequestAt = iso(fr.lastSentAt);
      if (fr.outcome === 'fetched' || fr.outcome === 'not-modified') {
        fs.failures = 0;
        fs.lastSuccessAt = iso(fr.lastSentAt);
        fs.lastOutcome = fr.outcome === 'fetched' ? 'ok' : 'not-modified';
        fs.nextDueAt = undefined;
        fs.etag = fr.etag;
        fs.lastModified = fr.lastModified;
      } else {
        fs.failures++;
        fs.lastOutcome = fr.error;
        const asked = fr.status === 503 ? Math.min(24 * 3600_000, retryAfterMs(fr.retryAfter, fr.lastSentAt) ?? 0) : 0;
        fs.nextDueAt = iso(fr.lastSentAt + Math.max(backoffMs(t.s.intervalMinutes, fs.failures), asked));
        // Gone, refused or unparseable: stop showing the old items. A network or server error keeps them for a while.
        if (!fr.retryable) fs.items = [];
      }
    } else if (fr.robotsRefused) {
      fs.lastOutcome = fr.error;
      fs.items = [];
      // An origin whose robots.txt cannot be read is asked again only after a backoff, not on every run.
      if (fr.robotsUnusable) {
        fs.failures++;
        fs.nextDueAt = iso(tEnd + backoffMs(t.s.intervalMinutes, fs.failures));
      }
    }

    let shown: Article[];
    let firstSeen = 0;
    if (fr.outcome === 'fetched') {
      const before = new Set(Object.keys(seen));
      shown = stampFirstSeen(fr.fresh!, seen, nowIso);
      firstSeen = shown.filter((a) => !before.has(a.id)).length;
      fs.items = shown
        .filter((a) => opts.now.getTime() - itemTime(a) <= window)
        .sort((x, y) => itemTime(y) - itemTime(x))
        .slice(0, MAX_STORED_ITEMS);
    } else {
      const recent = fs.lastSuccessAt !== undefined && tEnd - Date.parse(fs.lastSuccessAt) <= interval + CARRY_MS;
      shown = recent ? fs.items : [];
      if (fr.outcome === 'not-modified') for (const a of shown) seen[a.id] = { f: seen[a.id]?.f ?? a.firstSeenAt, l: nowIso };
    }
    const answering = fs.lastSuccessAt !== undefined && (fs.lastOutcome === 'ok' || fs.lastOutcome === 'not-modified')
      && tEnd - Date.parse(fs.lastSuccessAt) <= interval + CARRY_MS;

    const drop = new Set((t.s.filters?.dropWires ?? []).map((w) => w.toLowerCase()));
    const paths = t.s.filters?.excludePaths ?? [];
    // Items the publisher labels as sponsored or paid content are advertising, not journalism: left out.
    const kept = shown.filter((a) => !(a.wire && drop.has(a.wire.toLowerCase())) && !(paths.length > 0 && excludedPath(a.url, paths)) && !isSponsored(a.title));
    const next = earliestRequest(state ? fs : undefined, t.s.intervalMinutes);
    const rep: FeedReport = {
      sourceId: t.s.id, feed: t.f.url, outcome: fr.outcome, requests: fr.requests, bytes: fr.bytes ?? 0, status: fr.status,
      waitedMs: Math.round(fr.waitedMs), items: kept.length, firstSeen, undated: kept.filter((a) => a.publishedAt === null).length,
      error: fr.error, nextRequestAt: Number.isFinite(next) ? iso(next) : undefined,
    };
    reports.push(rep);
    const src = perSource.get(t.s.id) ?? { items: [], reports: [], answering: false };
    src.items.push(...kept);
    src.reports.push(rep);
    src.answering ||= answering;
    if (fs.lastSuccessAt && (!src.lastSuccess || fs.lastSuccessAt > src.lastSuccess)) src.lastSuccess = fs.lastSuccessAt;
    perSource.set(t.s.id, src);
  }

  const kept0: Article[] = [];
  const health: SourceHealth[] = [];
  for (const s of sources) {
    const r = perSource.get(s.id) ?? { items: [], reports: [], answering: false };
    const cutoff = opts.now.getTime() - (opts.maxAgeHours[s.section] ?? 48) * 3600_000;
    const items = r.items
      .filter((a) => itemTime(a) >= cutoff)
      .sort((x, y) => itemTime(y) - itemTime(x))
      .slice(0, opts.perSourceCap);
    kept0.push(...items);
    const newest = Math.max(0, ...r.items.map((a) => Date.parse(a.publishedAt ?? '') || 0));
    const stale = newest > 0 && opts.now.getTime() - newest > 7 * 24 * 3600_000;
    const outcomes = r.reports.map((x) => x.outcome);
    const status: SourceHealth['status'] = outcomes.includes('fetched') ? (stale ? 'stale' : 'fresh')
      : outcomes.includes('not-modified') ? 'not-modified'
        : outcomes.length > 0 && outcomes.every((o) => o === 'not-due') ? 'not-due'
          : outcomes.length > 0 && outcomes.every((o) => o === 'not-due' || o === 'skipped') ? 'skipped'
            : 'failed';
    health.push({
      sourceId: s.id,
      ok: r.answering,
      status,
      items: items.length,
      lastAttempt: nowIso,
      lastSuccess: r.lastSuccess,
      error: r.reports.find((x) => x.error)?.error ?? (r.reports.length === 0 ? 'not attempted' : undefined),
    });
  }

  if (state) {
    state.robots = Object.fromEntries(robotsCache!);
    for (const [o, t] of hostTimes) hosts[o] = { ...hosts[o], lastRequestAt: iso(t) };
    state.hosts = hosts;
    state.seen = seen;
  }

  const snapshot = assembleSnapshot(sources, kept0, { now: opts.now, mode: opts.mode, nextUpdateAt: opts.nextUpdateAt }, {
    sourcesOk: health.filter((h) => h.ok).length,
    durationMs: Date.now() - started,
    bytesFetched: spent(),
  });
  const traffic: RunTraffic = {
    feedRequests, robotsRequests: robots.stats.requests, robotsRefusals: robots.stats.refused,
    crawlDelayDeferrals: robots.stats.deferred, notDue: reports.filter((x) => x.outcome === 'not-due').length,
    notModified: reports.filter((x) => x.outcome === 'not-modified').length, coolDownSkips, bytes: spent(),
  };
  return { snapshot, health, traffic, feeds: reports };
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
  const news = kept.filter((a) => a.section !== 'airwaves' && a.section !== 'pulse');
  // Grouping reads English headlines only. A headline in another language stands on its own,
  // as a story with one outlet, until multilingual grouping exists; it is never translated.
  const clusters = [
    ...clusterArticles(news.filter((a) => isEnglish(a.language))),
    ...news.filter((a) => !isEnglish(a.language)).flatMap((a) => clusterArticles([a])),
  ];
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
