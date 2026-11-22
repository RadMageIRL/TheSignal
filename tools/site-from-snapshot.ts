// Turns a captured snapshot into a local review site folder. The captured headlines are run
// through the CURRENT pipeline (dedupe, grouping, placement, ranking) with the CURRENT registry's
// permissions and notices, and the RSS feeds are built from the result. Lets a capture be
// re-reviewed after code or research changes, without fetching anything again.
//
//   node tools/site-from-snapshot.ts <snapshot.json> <out-dir> [--registry registry/sources.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SourceEntry } from '../shared/types.ts';
import { decodeArticles, encodeSnapshot, type WireSnapshot } from '../shared/wire.ts';
import { buildAllFeeds } from '../shared/rss.ts';
import { assembleSnapshot } from '../ingest/run.ts';

const [input, out, ...rest] = process.argv.slice(2);
if (!input || !out) { console.log('usage: node tools/site-from-snapshot.ts <snapshot.json> <out-dir> [--registry file]'); process.exit(2); }
const regPath = rest.includes('--registry') ? rest[rest.indexOf('--registry') + 1]! : 'registry/sources.json';
const registry = new Map((JSON.parse(readFileSync(regPath, 'utf8')) as SourceEntry[]).map((s) => [s.id, s]));

const wire = JSON.parse(readFileSync(input, 'utf8')) as WireSnapshot;
const sources = wire.sources.map((s) => registry.get(s.id)).filter((s): s is SourceEntry => !!s);
const known = new Set(sources.map((s) => s.id));
const articles = [...decodeArticles(wire).values()].filter((a) => known.has(a.sourceId)).map((a) => {
  const n = registry.get(a.sourceId)?.network;
  return n ? { ...a, network: n } : a;
});
const snap = assembleSnapshot(sources, articles, { now: new Date(wire.generatedAt), mode: wire.mode, nextUpdateAt: wire.nextUpdateAt },
  { sourcesOk: wire.stats.sourcesOk, durationMs: wire.stats.durationMs, bytesFetched: wire.stats.bytesFetched });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'snapshot.json'), JSON.stringify(encodeSnapshot(snap)));
console.log(`${snap.articles.length} articles, ${snap.clusters.filter((c) => c.sourceCount > 1).length} multi-outlet stories, ${snap.perspectives.length} perspectives, ${snap.trending.length} trending, lead ${snap.leadClusterId}`);
for (const d of buildAllFeeds(snap, { feedUrlOf: (id) => registry.get(id)?.feeds[0]?.url })) {
  const f = join(out, d.spec.path);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, d.xml);
  console.log(`${d.spec.path}: ${d.items} items, ${d.bytes} bytes, ${d.excluded} left out`);
}
