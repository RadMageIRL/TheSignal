// Headlines in other languages: shown exactly as published, labeled with their language, kept out
// of English story grouping, marked in RSS, and filterable on the page and in search.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SourceEntry } from '../../shared/types.ts';
import { headlineLangAttrs, isEnglish, knownLanguage, languageName, primaryLanguage } from '../../shared/languages.ts';
import { assembleSnapshot } from '../../ingest/run.ts';
import { buildAllFeeds } from '../../shared/rss.ts';
import { validateRegistry } from '../../shared/registry.ts';
import { parseWire } from '../../shared/schema.ts';
import { decodeArticles, decodeClusters } from '../../shared/wire.ts';
import { buildView, offSources, type SiteData } from '../../src/lib/data.ts';
import { DEFAULT_FILTERS, searchArticles } from '../../src/lib/search.ts';
import { FIXTURE_NOW, fixtureArticles, fixtureSnapshot, fixtureSources } from '../fixtures/news-day.ts';

const SPANISH = ['gaceta-corvane', 'correo-briskvale'];

describe('language names', () => {
  it('names each language without guessing, and leaves the region to the country label', () => {
    expect(languageName('es')).toBe('Spanish');
    expect(languageName('pt-BR')).toBe('Portuguese');
    expect(languageName('zh-Hant-TW')).toBe('Chinese (Traditional)');
    expect(languageName('ar')).toBe('Arabic');
    expect(languageName('xx-YY')).toBe('xx-YY');
    expect(knownLanguage('xx-YY')).toBe(false);
    expect(primaryLanguage('es-AR')).toBe('es');
  });

  it('treats every English variant as English and nothing else', () => {
    for (const t of ['en', 'en-GB', 'en-AU', 'EN-us']) expect(isEnglish(t), t).toBe(true);
    for (const t of ['es', 'fr', 'ar', 'zh-Hant-TW', '']) expect(isEnglish(t), t).toBe(false);
  });

  it('marks up a non-English headline with its language and lets the browser set its direction', () => {
    expect(headlineLangAttrs('en-GB')).toEqual({});
    expect(headlineLangAttrs('ar')).toEqual({ lang: 'ar', dir: 'auto' });
    expect(headlineLangAttrs('zh-Hant-TW')).toEqual({ lang: 'zh-Hant-TW', dir: 'auto' });
  });

  it('rejects a registry source whose language cannot be named', () => {
    const s: SourceEntry = { ...fixtureSources()[0]!, language: 'xx' };
    expect(validateRegistry([s])).toEqual(['capitol-ledger: language xx has no name in shared/languages.ts']);
  });
});

describe('story grouping and other languages', () => {
  it('lists each non-English headline as its own story, keeping its words as published', async () => {
    const snap = await fixtureSnapshot();
    const foreign = snap.articles.filter((a) => !isEnglish(a.language));
    expect(foreign.map((a) => a.sourceId).sort()).toEqual(['barid-dunmere', 'correo-briskvale', 'gaceta-corvane']);
    for (const a of foreign) {
      const c = snap.clusters.find((x) => x.articleIds.includes(a.id))!;
      expect(c.articleIds, a.sourceId).toEqual([a.id]);
      expect(c.sourceCount).toBe(1);
    }
    expect(foreign.find((a) => a.sourceId === 'barid-dunmere')!.title).toBe('غرق عبّارة في بحيرة فارنو ومقتل 31 شخصاً');
  });

  it('keeps them apart only because of their language: the same two headlines marked English would group', () => {
    const sources = fixtureSources();
    const asEnglish = fixtureArticles().map((a) => (SPANISH.includes(a.sourceId) ? { ...a, language: 'en' } : a));
    const snap = assembleSnapshot(sources, asEnglish, { now: FIXTURE_NOW, mode: 'live', nextUpdateAt: null }, { sourcesOk: 1, durationMs: 0, bytesFetched: 0 });
    const ids = snap.articles.filter((a) => SPANISH.includes(a.sourceId)).map((a) => a.id);
    expect(snap.clusters.some((c) => ids.every((id) => c.articleIds.includes(id)))).toBe(true);
  });
});

describe('RSS items in other languages', () => {
  it('carry their language as dc:language and as a category, and English items carry neither', async () => {
    const world = buildAllFeeds(await fixtureSnapshot(), { feedUrlOf: (id) => `https://${id}.example/feed.xml` }).find((d) => d.spec.id === 'world')!;
    const items = world.xml.split('<item>').slice(1);
    const spanish = items.filter((x) => x.includes('<dc:language>'));
    expect(spanish.length).toBe(2);
    for (const x of spanish) expect(x).toMatch(/<category>Spanish<\/category>.*<dc:language>es(-ES)?<\/dc:language>/);
    // Barid Dunmere does not allow redistribution, so its Arabic headline is not in any feed.
    expect(world.xml.includes('فارنو')).toBe(false);
    expect(world.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">')).toBe(true);
  });
});

describe('filtering by language', () => {
  function site(): SiteData {
    const { wire } = parseWire(JSON.parse(readFileSync('tests/fixtures/site/snapshot.json', 'utf8')));
    const articles = decodeArticles(wire);
    return { wire, sources: new Map(wire.sources.map((s) => [s.id, s])), articles, baseClusters: decodeClusters(wire, articles) };
  }
  const d = site();
  const NOW = Date.parse('2026-11-22T12:00:00Z');

  it('narrows search results to one language and counts each language among the matches', () => {
    const view = buildView(d, new Set());
    // Seven English ferry reports and the encyclopedia entry, plus the two Spanish reports. The
    // Arabic report writes the name in Arabic script, so a search in Latin letters does not find it.
    const all = searchArticles(view, d.sources, 'varnu', DEFAULT_FILTERS, NOW);
    expect(all.facets.languages.map((f) => [f.value, f.count])).toEqual([['en', 8], ['es', 2]]);
    expect(searchArticles(view, d.sources, 'فارنو', DEFAULT_FILTERS, NOW).results.map((a) => a.sourceId)).toEqual(['barid-dunmere']);
    const es = searchArticles(view, d.sources, 'varnu', { ...DEFAULT_FILTERS, language: 'es' }, NOW);
    expect(es.results.map((a) => a.sourceId).sort()).toEqual(['correo-briskvale', 'gaceta-corvane']);
  });

  it('takes a hidden language off the page together with the sources the reader turned off', () => {
    expect([...offSources(d, { disabledSources: ['thames-herald'], hiddenLanguages: ['es'] })].sort()).toEqual(['correo-briskvale', 'gaceta-corvane', 'thames-herald']);
    expect([...offSources(d, { disabledSources: [], hiddenLanguages: ['ar'] })]).toEqual(['barid-dunmere']);
    const view = buildView(d, offSources(d, { disabledSources: [], hiddenLanguages: ['es', 'ar'] }));
    expect([...view.articles.values()].filter((a) => !isEnglish(a.language))).toEqual([]);
  });
});
