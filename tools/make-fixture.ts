// Builds the synthetic site fixture (tests/fixtures/site/) from tests/fixtures/news-day.ts with
// the same assembly and feed code a live collection uses. The fixture backs the end-to-end tests
// and the local preview when no private capture is present. Deterministic: rerunning it on
// unchanged code produces identical files (a unit test checks this).
//
//   node tools/make-fixture.ts [--check]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assembleSnapshot } from '../ingest/run.ts';
import { encodeSnapshot } from '../shared/wire.ts';
import { buildAllFeeds } from '../shared/rss.ts';
import { FIXTURE_NOW, fixtureArticles, fixtureSources } from '../tests/fixtures/news-day.ts';

export function buildFixtureFiles(): Map<string, string> {
  const sources = fixtureSources();
  const snapshot = assembleSnapshot(sources, fixtureArticles(), { now: FIXTURE_NOW, mode: 'prototype', nextUpdateAt: null },
    { sourcesOk: sources.length, durationMs: 0, bytesFetched: 0 });
  const files = new Map<string, string>();
  files.set('snapshot.json', JSON.stringify(encodeSnapshot(snapshot)) + '\n');
  const feedOf = new Map(sources.map((s) => [s.id, s.feeds[0]!.url] as const));
  for (const d of buildAllFeeds(snapshot, { feedUrlOf: (id) => feedOf.get(id) })) files.set(d.spec.path, d.xml);
  return files;
}

const OUT = 'tests/fixtures/site';

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/make-fixture.ts')) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [path, body] of buildFixtureFiles()) {
    const file = join(OUT, path);
    if (check) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== body) { console.log('STALE', file); stale++; }
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    console.log('wrote', file, body.length, 'bytes');
  }
  if (check) { console.log(stale ? `${stale} fixture files are stale; run node tools/make-fixture.ts` : 'fixture up to date'); process.exit(stale ? 1 : 0); }
}
