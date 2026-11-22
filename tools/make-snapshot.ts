// Captures one prototype snapshot for design review, plus the outgoing RSS feeds built from it.
// Only feeds that passed the latest validation (and whose robots.txt does not disallow them)
// are fetched. Output goes to local/ only, is marked mode "prototype", and is never published.
//
//   node tools/make-snapshot.ts [--ready-only | --collectable] [--registry registry/sources.json]
//   --collectable: only the sources cleared for production collection (enabled, READY, no gates)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { SourceEntry } from '../shared/types.ts';
import { collect, DEFAULT_RUN } from '../ingest/run.ts';
import { encodeSnapshot } from '../shared/wire.ts';
import { buildAllFeeds } from '../shared/rss.ts';
import { collectable } from '../shared/registry.ts';

interface ValidationRow { sourceId: string; url: string; finalHost: string; verdict: string; robots: boolean | null }

const args = process.argv.slice(2);
const readyOnly = args.includes('--ready-only');
const onlyCollectable = args.includes('--collectable');
const registryPath = args.includes('--registry') ? args[args.indexOf('--registry') + 1]! : 'registry/sources.json';

const all = JSON.parse(readFileSync(registryPath, 'utf8')) as SourceEntry[];
const registry = onlyCollectable ? collectable(all) : all;
const validation = JSON.parse(readFileSync('local/research/feeds/validation-latest.json', 'utf8')) as { results: ValidationRow[] };
const okByUrl = new Map<string, ValidationRow>();
for (const r of validation.results) if (r.verdict === 'ok' && r.robots !== false) okByUrl.set(r.url, r);

const now = new Date();
const sources: SourceEntry[] = [];
for (const c of registry) {
  if (readyOnly && c.status !== 'READY') continue;
  const feeds = c.feeds
    .map((f) => {
      const v = f.url.includes('{Y}')
        ? validation.results.find((r) => r.sourceId === c.id && r.verdict === 'ok')
        : okByUrl.get(f.url);
      if (!v) return null;
      return { ...f, redirectHosts: [...new Set([...(f.redirectHosts ?? []), v.finalHost])] };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (feeds.length === 0) continue;
  sources.push({ ...c, feeds });
}

console.log(`collecting ${sources.length} sources, ${sources.reduce((n, s) => n + s.feeds.length, 0)} feeds`);
const { snapshot, health } = await collect(sources, { ...DEFAULT_RUN, now, mode: 'prototype', nextUpdateAt: null, budgetMs: 180_000 });

const stamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
const tag = onlyCollectable ? 'collectable-' : readyOnly ? 'ready-' : '';
mkdirSync('local/snapshots', { recursive: true });
mkdirSync('local/site-data', { recursive: true });
const json = JSON.stringify(encodeSnapshot(snapshot));
writeFileSync(join('local/snapshots', `prototype-${tag}${stamp}.json`), json);
writeFileSync(join('local/snapshots', `health-${tag}${stamp}.json`), JSON.stringify(health, null, 1));
const siteDir = join('local/site-data', onlyCollectable ? 'collectable' : readyOnly ? 'ready-live' : 'all-live');
mkdirSync(siteDir, { recursive: true });
writeFileSync(join(siteDir, 'snapshot.json'), json);

const feedOf = new Map(sources.map((s) => [s.id, s.feeds[0]?.url] as const));
const rssDir = siteDir;
for (const d of buildAllFeeds(snapshot, { feedUrlOf: (id) => feedOf.get(id) })) {
  const out = join(rssDir, d.spec.path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, d.xml);
  console.log(`rss ${d.spec.path}: ${d.items} items, ${d.bytes} bytes, ${d.excluded} left out (no redistribution permission)`);
}

console.log(JSON.stringify(snapshot.stats));
console.log('bytes', json.length, 'gzip', gzipSync(json).length, 'lead', snapshot.leadClusterId, 'perspectives', snapshot.perspectives.length, 'trending', snapshot.trending.length);
for (const h of health.filter((x) => !x.ok)) console.log('FAILED', h.sourceId, h.error);
