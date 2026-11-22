// Production operations from this machine, with the stores' read-write tokens in the shell
// environment (PRIVATE_BLOB_READ_WRITE_TOKEN, PUBLIC_BLOB_READ_WRITE_TOKEN; never committed).
//
//   node tools/ops.ts status                  control file, identity, last runs
//   node tools/ops.ts on | off                create or delete control.json (off is the kill switch)
//   node tools/ops.ts drill                   control.json with "drill": "keep-last-good" (one run, then set on again)
//   node tools/ops.ts init                    write identity.json for the-signal/production (once)
//   node tools/ops.ts report [--hours 48]     roll up the operations logs
//   node tools/ops.ts history                 earlier snapshots kept for rollback
//   node tools/ops.ts rollback --to <stamp>   republish an earlier snapshot (collection must be off)
//
// Every command but report, history and status writes to a store, and each says what it did.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { del, list, put } from '@vercel/blob';
import type { SourceEntry } from '../shared/types.ts';
import { PATHS, BlobSiteStore, blobAuth, historyStamps, readControl, readPrivate, type BlobAuth } from '../ingest/blob.ts';
import { PROJECT } from '../ingest/production.ts';
import { JSON_CONTENT_TYPE, RSS_CONTENT_TYPE } from '../ingest/storage.ts';
import { collectable } from '../shared/registry.ts';
import { buildAllFeeds } from '../shared/rss.ts';
import { snapshotFromWire, type WireSnapshot } from '../shared/wire.ts';
import { validateWire } from '../shared/schema.ts';
import { rssProblems } from '../ingest/publish.ts';

interface OpsEntry {
  at: string; status: string; published?: boolean; reasons: string[]; drill?: string | null;
  report?: { traffic?: Record<string, number>; health?: { sourceId: string; ok: boolean; status: string; error?: string }[]; stats?: Record<string, number> };
  site?: { written: number; unchanged: number };
  requests?: { t: string; s?: number; ms?: number; at: number; hop: number }[];
}

/** Rolls up operations log entries: run outcomes, requests per host, bytes, failing sources, freshness gaps. */
export function summarize(entries: OpsEntry[]) {
  const byStatus: Record<string, number> = {};
  const perHost: Record<string, number> = {};
  const failing = new Map<string, { runs: number; last?: string }>();
  let bytes = 0; let feedRequests = 0; let robotsRequests = 0; let notModified = 0; let published = 0; let written = 0; let unchanged = 0;
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  let lastPublish: number | null = null;
  let longestGapMin = 0;
  for (const e of sorted) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (e.published) {
      const t = Date.parse(e.at);
      if (lastPublish !== null) longestGapMin = Math.max(longestGapMin, (t - lastPublish) / 60_000);
      lastPublish = t;
      published++;
    }
    const tr = e.report?.traffic ?? {};
    bytes += tr.bytes ?? 0; feedRequests += tr.feedRequests ?? 0; robotsRequests += tr.robotsRequests ?? 0; notModified += tr.notModified ?? 0;
    written += e.site?.written ?? 0; unchanged += e.site?.unchanged ?? 0;
    for (const r of e.requests ?? []) { const h = new URL(r.t).host; perHost[h] = (perHost[h] ?? 0) + 1; }
    for (const h of e.report?.health ?? []) {
      if (h.ok) continue;
      const f = failing.get(h.sourceId) ?? { runs: 0 };
      f.runs++; f.last = h.error;
      failing.set(h.sourceId, f);
    }
  }
  return {
    runs: sorted.length, byStatus, published, longestGapBetweenPublishesMin: Math.round(longestGapMin),
    firstRun: sorted[0]?.at, lastRun: sorted.at(-1)?.at,
    requests: { feed: feedRequests, robots: robotsRequests, notModified, perHost: Object.fromEntries(Object.entries(perHost).sort((a, b) => b[1] - a[1])) },
    bytesRead: bytes, blobWrites: { written, unchanged },
    failingSources: Object.fromEntries([...failing].sort((a, b) => b[1].runs - a[1].runs)),
  };
}

export async function entriesSince(auth: BlobAuth, sinceMs: number): Promise<OpsEntry[]> {
  const out: OpsEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: PATHS.ops, cursor, limit: 1000, ...auth });
    for (const b of page.blobs) {
      const m = /(\d{8}T\d{6})/.exec(b.pathname);
      if (!m) continue;
      const t = Date.parse(`${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6, 8)}T${m[1]!.slice(9, 11)}:${m[1]!.slice(11, 13)}:${m[1]!.slice(13, 15)}Z`);
      if (t < sinceMs) continue;
      const r = await readPrivate(b.pathname, auth);
      if (r) out.push(JSON.parse(r.text) as OpsEntry);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Rebuilds the feeds from an earlier snapshot and publishes both. Refused while collection is on. */
export async function rollback(priv: BlobAuth, pub: BlobAuth, registry: SourceEntry[], stamp: string, build: typeof buildAllFeeds = buildAllFeeds): Promise<string> {
  const ctl = await readControl(priv);
  if (ctl.stop === undefined) throw new Error('collection is on: run "node tools/ops.ts off" first, or the next run replaces the rollback');
  if (!/^[0-9TZ]+$/.test(stamp)) throw new Error('bad stamp');
  const r = await readPrivate(`${PATHS.history}${stamp}/snapshot.json`, priv);
  if (!r) throw new Error(`no history version ${stamp}`);
  const wire = JSON.parse(r.text) as WireSnapshot;
  const problems = validateWire(wire);
  if (problems.length > 0) throw new Error(`history version fails the schema: ${problems[0]}`);
  const snapshot = snapshotFromWire(wire);
  const feedOf = new Map(collectable(registry).map((s) => [s.id, s.feeds[0]?.url] as const));
  const feeds = build(snapshot, { feedUrlOf: (id) => feedOf.get(id) });
  const rss = rssProblems(feeds, snapshot);
  if (rss.length > 0) throw new Error(`rebuilt feeds fail the RSS checks: ${rss[0]}`);
  const site = new BlobSiteStore(pub, priv, Number.MAX_SAFE_INTEGER);
  await site.publish([
    { path: 'snapshot.json', body: r.text, contentType: JSON_CONTENT_TYPE },
    ...feeds.map((d) => ({ path: d.spec.path, body: d.xml, contentType: RSS_CONTENT_TYPE })),
  ], `${stamp}-rollback`);
  return `republished snapshot ${stamp} (generated ${wire.generatedAt}) and ${feeds.length} feeds; ${site.stats.written} files written`;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n: string, d?: string) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
  const priv = blobAuth(process.env, 'PRIVATE');
  const pub = blobAuth(process.env, 'PUBLIC');
  if (!priv) { console.error('PRIVATE_BLOB_READ_WRITE_TOKEN is not set'); process.exit(1); }
  const writeJson = (path: string, value: unknown) => put(path, JSON.stringify(value), { access: 'private', contentType: JSON_CONTENT_TYPE, addRandomSuffix: false, allowOverwrite: true, ...priv });
  if (cmd === 'status') {
    console.log('control:', JSON.stringify(await readControl(priv)));
    console.log('identity:', (await readPrivate(PATHS.identity, priv))?.text ?? 'missing');
    const recent = await entriesSince(priv, Date.now() - 2 * 3600_000);
    for (const e of recent.sort((a, b) => a.at.localeCompare(b.at)).slice(-8)) console.log(e.at, e.status, e.published ? 'published' : '', (e.reasons ?? []).slice(0, 1).join(''));
  } else if (cmd === 'on') { await writeJson(PATHS.control, { collect: 'on' }); console.log('control.json: collect on (takes effect at the next run)'); }
  else if (cmd === 'drill') { await writeJson(PATHS.control, { collect: 'on', drill: 'keep-last-good' }); console.log('control.json: drill set; the next run collects but must not publish. Run "on" afterwards.'); }
  else if (cmd === 'off') { await del(PATHS.control, { ...priv }); console.log('control.json deleted: the next run stops before any request'); }
  else if (cmd === 'init') {
    if (await readPrivate(PATHS.identity, priv)) { console.error('identity.json already exists; not overwritten'); process.exit(1); }
    await writeJson(PATHS.identity, { deployment: 'production', project: PROJECT });
    console.log(`identity.json written: ${PROJECT}/production`);
  } else if (cmd === 'report') {
    const hours = Number(opt('--hours', '48'));
    console.log(JSON.stringify(summarize(await entriesSince(priv, Date.now() - hours * 3600_000)), null, 1));
  } else if (cmd === 'history') { for (const s of await historyStamps(priv)) console.log(s); }
  else if (cmd === 'rollback') {
    if (!pub) { console.error('PUBLIC_BLOB_READ_WRITE_TOKEN is not set'); process.exit(1); }
    const registry = JSON.parse(readFileSync('registry/sources.json', 'utf8')) as SourceEntry[];
    console.log(await rollback(priv, pub, registry, opt('--to') ?? ''));
  } else { console.error('usage: node tools/ops.ts status|on|off|drill|init|report|history|rollback --to <stamp>'); process.exit(1); }
}
