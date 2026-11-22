// One scheduled run from start to finish, minus where the files go: read the controls and the
// saved collector state, collect from the sources that are cleared for production, check the
// result, and hand back the files to publish. The caller writes them only when the outcome is
// "publish"; any other outcome leaves the last good snapshot and feeds exactly where they are.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { SourceEntry, SourceHealth, Snapshot } from '../shared/types.ts';
import { collectable } from '../shared/registry.ts';
import { encodeSnapshot } from '../shared/wire.ts';
import { validateWire } from '../shared/schema.ts';
import { safeLink } from '../shared/url.ts';
import { buildAllFeeds, type RssDocument } from '../shared/rss.ts';
import { collect, latestRequestOffsetMs, planRun, runOptionsFrom, type FeedReport, type Fetcher, type RunTraffic } from './run.ts';
import type { RequestEvent } from './fetch.ts';
import type { Controls } from './controls.ts';
import type { RobotsCacheEntry } from './robots.ts';
import { pruneState, withReservations, type CollectorState, type StateStore } from './state.ts';

/** Runs closer together than this are refused (a scheduler can deliver the same run twice). */
export const MIN_RUN_GAP_MS = 10 * 60_000;

export interface RunReport {
  health: SourceHealth[];
  stats: Snapshot['stats'];
  traffic: RunTraffic;
  feeds: FeedReport[];
  /** Notes about the run itself, e.g. that the previous run did not finish. */
  notes: string[];
}

export type RunOutcome =
  | { status: 'suspended'; reasons: string[] }
  | { status: 'too-soon'; reasons: string[] }
  | { status: 'kept-last-good'; reasons: string[]; health: SourceHealth[]; stats: Snapshot['stats'] | null; traffic: RunTraffic | null; report?: RunReport }
  | { status: 'publish'; reasons: []; snapshotJson: string; feeds: RssDocument[]; health: SourceHealth[]; stats: Snapshot['stats']; traffic: RunTraffic; report: RunReport };

const bytesOf = (s: string) => new TextEncoder().encode(s).length;

/** Reasons a finished run must not replace the published snapshot (empty = publishable). */
export function publishProblems(snapshot: Snapshot, json: string, c: Controls): string[] {
  const out: string[] = [];
  const size = bytesOf(json);
  if (size > c.maxSnapshotBytes) out.push(`snapshot is ${size} bytes, over the ${c.maxSnapshotBytes} byte limit`);
  const { sourcesAttempted, sourcesOk } = snapshot.stats;
  if (sourcesAttempted === 0 || sourcesOk / sourcesAttempted < c.minSourceShare) {
    out.push(`only ${sourcesOk} of ${sourcesAttempted} sources answered (need ${Math.round(c.minSourceShare * 100)} percent)`);
  }
  if (snapshot.articles.length < c.minArticles) out.push(`only ${snapshot.articles.length} articles (need ${c.minArticles})`);
  const schema = validateWire(JSON.parse(json));
  if (schema.length > 0) out.push(`schema: ${schema.slice(0, 3).join('; ')}${schema.length > 3 ? ` and ${schema.length - 3} more` : ''}`);
  return out;
}

const rssParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

/**
 * Checks every outgoing feed before it may be published: well-formed XML, an RSS 2.0 channel
 * with title, link and description, and every item from a source that allows redistribution.
 */
export function rssProblems(feeds: RssDocument[], snapshot: Snapshot): string[] {
  const out: string[] = [];
  const allowed = new Set(snapshot.sources.filter((s) => s.syndicate === true).map((s) => s.id));
  const sourceOfUrl = new Map(snapshot.articles.map((a) => [safeLink(a.url) ?? a.url, a.sourceId] as const));
  for (const d of feeds) {
    const where = d.spec.path;
    if (XMLValidator.validate(d.xml) !== true) { out.push(`${where}: not well-formed XML`); continue; }
    const doc = rssParser.parse(d.xml) as { rss?: { '@version'?: string; channel?: Record<string, unknown> } };
    const ch = doc.rss?.channel;
    if (doc.rss?.['@version'] !== '2.0' || !ch || !ch.title || !ch.link || !ch.description) { out.push(`${where}: not an RSS 2.0 channel`); continue; }
    const items = ch.item === undefined ? [] : Array.isArray(ch.item) ? ch.item : [ch.item];
    if (items.length !== d.items) out.push(`${where}: ${items.length} items, expected ${d.items}`);
    for (const it of items as { link?: string }[]) {
      const src = sourceOfUrl.get(String(it.link ?? ''));
      if (!src || !allowed.has(src)) { out.push(`${where}: item ${String(it.link ?? '(no link)').slice(0, 80)} is not from a source that allows redistribution`); break; }
    }
  }
  return out;
}

export interface RunDeps {
  fetcher?: Fetcher;
  cadenceMinutes?: number;
  /** Saved collector state. Without one every feed is due (one-off runs and most tests). */
  store?: StateStore;
  /** Only used without a store. */
  robotsCache?: Map<string, RobotsCacheEntry>;
  observe?: (e: RequestEvent) => void;
  minRunGapMs?: number;
  /** Test seam: replaces the feed builder, to prove a feed that fails the RSS checks is never published. */
  buildFeeds?: typeof buildAllFeeds;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runCollection(registry: SourceEntry[], c: Controls, now: Date, deps: RunDeps = {}): Promise<RunOutcome> {
  if (!c.ingest) return { status: 'suspended', reasons: ['ingestion is switched off (SIGNAL_INGEST is not "on")'] };
  const sources = collectable(registry);
  if (sources.length === 0) return { status: 'kept-last-good', reasons: ['no sources are cleared for collection'], health: [], stats: null, traffic: null };
  const notes: string[] = [];
  let state: CollectorState | undefined;
  const opts = { ...runOptionsFrom(c), now, mode: 'live' as const, fetcher: deps.fetcher, observe: deps.observe, clock: deps.clock, sleep: deps.sleep };
  if (deps.store) {
    const loaded = await deps.store.load(now);
    // Without a trustworthy schedule the collector cannot know what it may request: it stops.
    if (loaded.problem !== undefined) return { status: 'suspended', reasons: [`collector state is unreadable (${loaded.problem}); nothing was requested`] };
    state = loaded.state;
    if (loaded.fresh) notes.push('no saved collector state: first run');
    const last = Date.parse(state.lastRunStartedAt ?? '');
    const gap = deps.minRunGapMs ?? MIN_RUN_GAP_MS;
    if (now.getTime() - last < gap) {
      return { status: 'too-soon', reasons: [`the previous run started at ${state.lastRunStartedAt}; runs must be at least ${Math.round(gap / 60_000)} minutes apart`] };
    }
    if (state.inFlight) notes.push(`the run started at ${state.inFlight.startedAt} did not finish; its reservations were honored`);
    // Saved before the first request: every feed this run may request, and its origins, are
    // marked as contacted at the latest moment the run could reach them.
    const clockNow = (deps.clock ?? Date.now)();
    const { due } = planRun(sources, state, clockNow, now);
    const origins = new Set<string>();
    for (const t of due) {
      origins.add(new URL(t.url).origin);
      for (const h of t.f.redirectHosts ?? []) origins.add(`https://${h}`);
    }
    const until = new Date(clockNow + latestRequestOffsetMs(opts));
    try {
      await deps.store.save(withReservations(state, due.map((t) => t.key), origins, now, until));
    } catch (e) {
      return { status: 'suspended', reasons: [`reservations could not be saved (${e instanceof Error ? e.message : 'unknown error'}); nothing was requested`] };
    }
  }
  const next = new Date(now.getTime() + (deps.cadenceMinutes ?? 15) * 60_000).toISOString();
  const { snapshot, health, traffic, feeds: feedLog } = await collect(sources, {
    ...opts, nextUpdateAt: next, state, robotsCache: state ? undefined : deps.robotsCache,
  });
  const report: RunReport = { health, stats: snapshot.stats, traffic, feeds: feedLog, notes };
  if (deps.store && state) {
    state.inFlight = undefined;
    state.lastRunStartedAt = now.toISOString();
    state.savedAt = new Date((deps.clock ?? Date.now)()).toISOString();
    pruneState(state, new Set(sources.flatMap((s) => s.feeds.map((f) => `${s.id} ${f.url}`))), now);
    try {
      await deps.store.save(state);
    } catch (e) {
      // The reservations saved before the run still stand, so nothing is requested early; but a
      // run whose state cannot be saved does not publish either.
      return { status: 'kept-last-good', reasons: [`collector state could not be saved (${e instanceof Error ? e.message : 'unknown error'})`], health, stats: snapshot.stats, traffic, report };
    }
  }
  const json = JSON.stringify(encodeSnapshot(snapshot));
  const reasons = publishProblems(snapshot, json, c);
  if (reasons.length > 0) return { status: 'kept-last-good', reasons, health, stats: snapshot.stats, traffic, report };
  const feedOf = new Map(sources.map((s) => [s.id, s.feeds[0]?.url] as const));
  const feeds = c.rss ? (deps.buildFeeds ?? buildAllFeeds)(snapshot, { feedUrlOf: (id) => feedOf.get(id) }) : [];
  const rss = rssProblems(feeds, snapshot);
  if (rss.length > 0) return { status: 'kept-last-good', reasons: rss.slice(0, 5), health, stats: snapshot.stats, traffic, report };
  return { status: 'publish', reasons: [], snapshotJson: json, feeds, health, stats: snapshot.stats, traffic, report };
}
