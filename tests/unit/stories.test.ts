// Story-level behavior on the synthetic fixtures: outlet counting and shared copy, the fixture
// itself, and the known fragmentation of very large stories (kept as a Phase 3 regression fixture).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { clusterArticles, copyNotes, countOrigins, sharedCopyOutlets } from '../../shared/cluster.ts';
import { fixtureSnapshot } from '../fixtures/news-day.ts';
import { fragmentedStory } from '../fixtures/fragmented-story.ts';
import { buildFixtureFiles } from '../../tools/make-fixture.ts';
import { SECTION_ORDER } from '../../shared/labels.ts';

describe('shared copy', () => {
  const base = { publishedAt: '2026-11-22T10:00:00Z', fetchedAt: '2026-11-22T12:00:00Z' };

  it('marks a word-for-word headline from a different outlet as the same headline as the earlier one', () => {
    const arts = [
      { ...base, id: 'a', sourceId: 'one', title: 'Bridge reopens after repairs' },
      { ...base, id: 'b', sourceId: 'two', title: 'Bridge reopens after repairs', publishedAt: '2026-11-22T10:30:00Z' },
    ];
    expect(copyNotes(arts).get('b')).toEqual({ sameAs: 'a' });
    expect(copyNotes(arts).has('a')).toBe(false);
  });

  it('does not mark a repeated headline from the same outlet as shared copy', () => {
    const arts = [
      { ...base, id: 'a', sourceId: 'one', title: 'Bridge reopens after repairs' },
      { ...base, id: 'b', sourceId: 'one', title: 'Bridge reopens after repairs' },
    ];
    expect(copyNotes(arts).size).toBe(0);
    expect(sharedCopyOutlets(arts)).toBe(0);
  });

  it('marks wire credits only when two or more outlets carry the same wire', () => {
    const one = [{ ...base, id: 'a', sourceId: 'one', title: 'Quake hits coast', wire: 'AP' }, { ...base, id: 'b', sourceId: 'two', title: 'Coastal quake' }];
    expect(copyNotes(one).size).toBe(0);
    const two = [...one, { ...base, id: 'c', sourceId: 'three', title: 'Coast struck by quake', wire: 'AP' }];
    expect([...copyNotes(two).keys()].sort()).toEqual(['a', 'c']);
    expect(sharedCopyOutlets(two)).toBe(2);
  });

  it('counts the fixture lead story as 7 outlets with 2 carrying shared copy and 6 distinct origins', async () => {
    const snap = await fixtureSnapshot();
    const lead = snap.clusters.find((c) => c.id === snap.leadClusterId)!;
    const arts = lead.articleIds.map((id) => snap.articles.find((a) => a.id === id)!);
    expect(lead.sourceCount).toBe(7);
    expect(lead.countryCount).toBe(7);
    expect(sharedCopyOutlets(arts)).toBe(2);
    expect(countOrigins(arts)).toBe(6);
    expect(lead.originCount).toBe(6);
  });
});

describe('the synthetic site fixture', () => {
  it('is up to date with the code that builds it', () => {
    for (const [path, body] of buildFixtureFiles()) {
      expect(readFileSync(`tests/fixtures/site/${path}`, 'utf8'), path).toBe(body);
    }
  });

  it('fills all six sections, a lead story, Global Perspectives and trending', async () => {
    const snap = await fixtureSnapshot();
    for (const s of SECTION_ORDER) {
      const n = Object.values(snap.layout[s]).reduce((k, l) => k + (l?.length ?? 0), 0);
      expect(n, s).toBeGreaterThan(0);
    }
    expect(snap.leadClusterId).not.toBeNull();
    expect(snap.perspectives.length).toBeGreaterThanOrEqual(2);
    expect(snap.trending.length).toBeGreaterThanOrEqual(1);
  });

  it('contains no real publisher domains', () => {
    const text = readFileSync('tests/fixtures/site/snapshot.json', 'utf8');
    const hosts = new Set([...text.matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1]!));
    expect([...hosts].filter((h) => !h.endsWith('.example') && h !== 'radmagelabs.com')).toEqual([]);
  });
});

describe('very large stories (Phase 3 regression fixture)', () => {
  const arts = fragmentedStory();
  const clusters = clusterArticles(arts);
  const story = new Map(arts.map((a) => [a.id, a.story]));

  it('never merges a different event into the arrest story (precision comes first)', () => {
    for (const c of clusters) {
      const kinds = new Set(c.articleIds.map((id) => story.get(id)));
      if (kinds.has('arrest')) expect([...kinds], c.id).toEqual(['arrest']);
    }
  });

  it('groups at least some of the differently worded reports together', () => {
    const arrestGroups = clusters.filter((c) => c.articleIds.some((id) => story.get(id) === 'arrest'));
    expect(arrestGroups.some((c) => c.articleIds.length >= 2)).toBe(true);
  });

  // KNOWN LIMITATION, kept on purpose: cautious grouping splits this one event into several
  // groups. This test is expected to FAIL today; when the Phase 3 second merge pass lands and the
  // reports form one story, it starts passing and Vitest reports it, so the marker must be removed.
  it.fails('KNOWN LIMITATION (Phase 3): all twelve reports of the arrest form one story', () => {
    const arrestGroups = clusters.filter((c) => c.articleIds.some((id) => story.get(id) === 'arrest'));
    expect(arrestGroups).toHaveLength(1);
  });
});

describe('country counts', () => {
  it('never counts multinational (INT) or EU outlets as a country, but still counts each real country once', async () => {
    const { countryCountOf } = await import('../../shared/cluster.ts');
    expect(countryCountOf([{ country: 'ZA' }, { country: 'INT' }, { country: 'US' }, { country: 'ZA' }, { country: 'EU' }])).toBe(2);
    expect(countryCountOf([{ country: 'INT' }, { country: 'EU' }])).toBe(0);
  });
});
