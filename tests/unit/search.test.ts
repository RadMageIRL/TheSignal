import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWire } from '../../shared/schema.ts';
import { decodeArticles, decodeClusters } from '../../shared/wire.ts';
import { buildView, type SiteData } from '../../src/lib/data.ts';
import { DEFAULT_FILTERS, RESULT_LIMIT, queryTerms, searchArticles } from '../../src/lib/search.ts';

function site(): SiteData {
  const { wire } = parseWire(JSON.parse(readFileSync('tests/fixtures/site/snapshot.json', 'utf8')));
  const articles = decodeArticles(wire);
  return { wire, sources: new Map(wire.sources.map((s) => [s.id, s])), articles, baseClusters: decodeClusters(wire, articles) };
}
const NOW = Date.parse('2026-11-22T12:00:00Z');

describe('search', () => {
  const d = site();
  const view = buildView(d, new Set());
  const run = (q: string, f = DEFAULT_FILTERS) => searchArticles(view, d.sources, q, f, NOW);

  it('finds every headline that contains all the words, ignoring case and punctuation', () => {
    const r = run('LAKE varnu!');
    // Six of the seven ferry reports say "Lake Varnu" (one says only "Varnu"), plus the encyclopedia entry.
    expect(r.total).toBe(7);
    expect(r.results.every((a) => /lake varnu/i.test(a.title))).toBe(true);
  });

  it('matches publisher and country names as well as headlines', () => {
    expect(run('thames herald').results.every((a) => a.sourceId === 'thames-herald')).toBe(true);
    expect(run('thames herald').total).toBeGreaterThan(1);
    expect(run('nigeria').results.every((a) => a.country === 'NG')).toBe(true);
  });

  it('returns nothing for a query without a two-letter word', () => {
    expect(run('a').total).toBe(0);
    expect(queryTerms('a b')).toEqual([]);
  });

  it('filters by section, source and country, and reports facet counts from the unfiltered matches', () => {
    const all = run('varnu');
    const world = run('varnu', { ...DEFAULT_FILTERS, section: 'world' });
    expect(world.results.every((a) => a.section === 'world')).toBe(true);
    expect(world.total).toBeLessThan(all.total);
    expect(world.facets.sections.reduce((n, f) => n + f.count, 0)).toBe(all.total);
    const one = run('varnu', { ...DEFAULT_FILTERS, source: 'kiwi-dispatch' });
    expect(one.results.map((a) => a.sourceId)).toEqual(['kiwi-dispatch']);
    expect(run('varnu', { ...DEFAULT_FILTERS, country: 'JP' }).results.map((a) => a.country)).toEqual(['JP']);
  });

  it('filters by publication age', () => {
    const recent = run('council', { ...DEFAULT_FILTERS, within: '6h' });
    expect(recent.total).toBeGreaterThan(0);
    expect(recent.results.every((a) => NOW - Date.parse(a.publishedAt!) <= 6 * 3600_000)).toBe(true);
    expect(run('council', { ...DEFAULT_FILTERS, within: '24h' }).total).toBeGreaterThan(recent.total);
  });

  it('sorts newest first by default and by number of outlets on request', () => {
    const newest = run('summit').results.map((a) => Date.parse(a.publishedAt!));
    expect(newest).toEqual([...newest].sort((x, y) => y - x));
    // A newer single-outlet headline: first by date, last by number of outlets.
    const fresh = { ...[...view.articles.values()].find((a) => a.sourceId === 'circuit-review')!, id: 'fresh-1',
      title: 'Ferry operator issues statement', publishedAt: '2026-11-22T11:55:00Z' };
    const v2 = { ...view, articles: new Map([...view.articles, [fresh.id, fresh]]) };
    const mixed = searchArticles(v2, d.sources, 'ferry', DEFAULT_FILTERS, NOW);
    const byCoverage = searchArticles(v2, d.sources, 'ferry', { ...DEFAULT_FILTERS, sort: 'coverage' }, NOW);
    expect(mixed.results[0]!.id).toBe('fresh-1');
    expect(byCoverage.results.at(-1)!.id).toBe('fresh-1');
    expect(byCoverage.total).toBe(mixed.total);
    const outlets = (id: string) => view.clusters.get(view.clusterOf.get(id) ?? '')?.sourceCount ?? 1;
    const counts = byCoverage.results.map((a) => outlets(a.id));
    expect(counts).toEqual([...counts].sort((x, y) => y - x));
  });

  it('shows at most the result limit and says how many matched', () => {
    const r = run('council');
    expect(r.results.length).toBe(Math.min(RESULT_LIMIT, r.total));
    expect(r.total).toBeGreaterThan(RESULT_LIMIT - 20);
  });
});
