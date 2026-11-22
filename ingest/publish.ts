// One scheduled run from start to finish, minus storage: read the controls, collect from the
// sources that are cleared for production, check the result, and hand back the files to
// publish. Storage (Phase 2) writes them only when the outcome is "publish"; any other outcome
// leaves the last good snapshot and feeds exactly where they are.
import type { SourceEntry, SourceHealth, Snapshot } from '../shared/types.ts';
import { collectable } from '../shared/registry.ts';
import { encodeSnapshot } from '../shared/wire.ts';
import { validateWire } from '../shared/schema.ts';
import { buildAllFeeds, type RssDocument } from '../shared/rss.ts';
import { collect, runOptionsFrom, type Fetcher } from './run.ts';
import type { Controls } from './controls.ts';

export type RunOutcome =
  | { status: 'suspended'; reasons: string[] }
  | { status: 'kept-last-good'; reasons: string[]; health: SourceHealth[]; stats: Snapshot['stats'] | null }
  | { status: 'publish'; reasons: []; snapshotJson: string; feeds: RssDocument[]; health: SourceHealth[]; stats: Snapshot['stats'] };

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

export async function runCollection(
  registry: SourceEntry[],
  c: Controls,
  now: Date,
  deps: { fetcher?: Fetcher; cadenceMinutes?: number } = {},
): Promise<RunOutcome> {
  if (!c.ingest) return { status: 'suspended', reasons: ['ingestion is switched off (SIGNAL_INGEST is not "on")'] };
  const sources = collectable(registry);
  if (sources.length === 0) return { status: 'kept-last-good', reasons: ['no sources are cleared for collection'], health: [], stats: null };
  const next = new Date(now.getTime() + (deps.cadenceMinutes ?? 15) * 60_000).toISOString();
  const { snapshot, health } = await collect(sources, { ...runOptionsFrom(c), now, mode: 'live', nextUpdateAt: next, fetcher: deps.fetcher });
  const json = JSON.stringify(encodeSnapshot(snapshot));
  const reasons = publishProblems(snapshot, json, c);
  if (reasons.length > 0) return { status: 'kept-last-good', reasons, health, stats: snapshot.stats };
  const feedOf = new Map(sources.map((s) => [s.id, s.feeds[0]?.url] as const));
  const feeds = c.rss ? buildAllFeeds(snapshot, { feedUrlOf: (id) => feedOf.get(id) }) : [];
  return { status: 'publish', reasons: [], snapshotJson: json, feeds, health, stats: snapshot.stats };
}
