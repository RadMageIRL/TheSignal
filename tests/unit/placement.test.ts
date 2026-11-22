import { describe, expect, it } from 'vitest';
import type { Article, SectionId, Subsection } from '../../shared/types.ts';
import { buildLayout, placeCluster, scoreCluster } from '../../shared/layout.ts';
import { countOrigins } from '../../shared/cluster.ts';
import { SOFT_FACTOR, softTopic } from '../../shared/topics.ts';
import { SECTION_OF_SUB } from '../../shared/layout.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
let n = 0;
function art(sourceId: string, sub: Subsection, title: string, extra: Partial<Article> = {}): Article {
  n++;
  return {
    id: `p${n}`, sourceId, title, url: `https://${sourceId}.example/${n}`, publishedAt: '2026-11-22T10:00:00Z',
    fetchedAt: '2026-11-22T12:00:00Z', section: SECTION_OF_SUB[sub] as SectionId, subsection: sub, contentType: 'reporting',
    country: 'GB', language: 'en', ...extra,
  };
}
const cluster = (arts: Article[]) => ({
  id: 'c', articleIds: arts.map((a) => a.id), leadArticleId: arts[0]!.id, sourceCount: arts.length, countryCount: 1,
  originCount: arts.length, firstSeen: '2026-11-22T10:00:00Z', lastSeen: '2026-11-22T10:00:00Z', score: 0,
});
const place = (...arts: Article[]) => placeCluster(cluster(arts), arts, arts[0]!);

describe('where a story is placed', () => {
  it('files a world story by the place its headline names, not by the regional feed that carried it', () => {
    expect(place(art('gulf', 'mideast', 'Fire at Indonesian candy factory leaves 3 dead'))).toEqual({ section: 'world', sub: 'asia' });
    expect(place(art('asiafeed', 'asia', 'Russian cargo ship on fire in Gulf of Finland'))).toEqual({ section: 'world', sub: 'europe' });
  });

  it('keeps the feed region when the headline names no place', () => {
    expect(place(art('asiafeed', 'asia', 'Education chief resigns amid cheating scandal'))).toEqual({ section: 'world', sub: 'asia' });
    expect(place(art('wire', 'world-general', 'Draft deal aims to avert collapse of climate talks'))).toEqual({ section: 'world', sub: 'world-general' });
  });

  it('moves a U.S. domestic story that arrived through a world feed to U.S. & Politics', () => {
    expect(place(art('gulf', 'mideast', 'Immigration officers make arrests at Seattle airport, delaying flight'))).toEqual({ section: 'us', sub: 'national' });
  });

  it('moves a story from U.S. outlets that names only a foreign place to World', () => {
    expect(place(art('usdaily', 'national', 'Now is not the time for Europe to relax'))).toEqual({ section: 'world', sub: 'europe' });
  });

  it('keeps a U.S. story that names a foreign place and a U.S. institution in U.S. & Politics', () => {
    expect(place(art('usdaily', 'washington', 'Senate passes Ukraine aid package after late vote'))).toEqual({ section: 'us', sub: 'washington' });
  });

  it('uses the place that most headlines in the story name', () => {
    const p = place(
      art('a', 'europe', 'Talks in Doha stall over ceasefire terms'),
      art('b', 'europe', 'Qatar hosts ceasefire talks as Gaza deal stalls'),
      art('c', 'asia', 'Beijing envoy joins Doha talks'),
    );
    expect(p).toEqual({ section: 'world', sub: 'mideast' });
  });
});

describe('soft topics in news columns', () => {
  it('recognizes sports results, advice columns, programming notes and reviews', () => {
    expect(softTopic('Kansas City Current capture first NWSL trophy')).toBe('sports');
    expect(softTopic('Chiefs quarterback ruled out for the season')).toBe('sports');
    expect(softTopic('My husband is happily retired at 64 and thinks I should keep working. Is he being fair?')).toBe('advice');
    expect(softTopic("I'm in my 40s. Should I accept a lower pension in exchange for naming my child as a beneficiary?")).toBe('advice');
    expect(softTopic("'It's downright dirty': My brother moved in with our mother and closed her bank account. What can I do?")).toBe('advice');
    expect(softTopic('This week on "Sunday Morning" (Nov. 22): The Food Issue')).toBe('programming');
    expect(softTopic("Here's what happened in crypto today")).toBe('programming');
    expect(softTopic('Review: Godzilla Minus Zero joins the list of stellar sequels')).toBe('review');
  });

  it('leaves ordinary news alone, including news that mentions sport or reviews in passing', () => {
    for (const t of ['Senate passes Harlow infrastructure bill', 'Stadium funding plan faces council vote', 'My Lai survivors return to Vietnam',
      'Pentagon orders review of base security', 'Report reviews ferry safety rules',
      'Can I vote by mail? What the new state rules say', 'Should Europe rearm faster? Leaders split at summit']) {
      expect(softTopic(t), t).toBeNull();
    }
  });

  it('ranks a sports result below a news story of the same age and coverage, by the stated factor', () => {
    const news = art('a', 'national', 'Senate passes Harlow infrastructure bill');
    const sport = art('b', 'national', 'Kansas City Current capture first NWSL trophy');
    const s1 = scoreCluster(cluster([news]), news, NOW);
    const s2 = scoreCluster(cluster([sport]), sport, NOW);
    // The methodology page says these rank at about a third of a news story's weight.
    expect(s2 / s1).toBeCloseTo(0.35, 6);
    expect(SOFT_FACTOR.sports).toBe(0.35);
  });
});

describe('editorial networks', () => {
  it('counts outlets of one network as one origin', () => {
    const a = art('conv-uk', 'europe', 'Why the ocean treaty matters', { network: 'the-conversation' });
    const b = art('conv-au', 'asia', 'What the ocean treaty means for the Pacific', { network: 'the-conversation' });
    const c = art('herald', 'europe', 'Ocean treaty agreed after long talks');
    expect(countOrigins([a, b, c])).toBe(2);
    expect(countOrigins([{ ...a, network: undefined }, { ...b, network: undefined }, c])).toBe(3);
  });

  it('applies the two-stories-per-publisher cap to a whole network', () => {
    const arts = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((w, i) =>
      art(`edition${i}`, 'europe', `${w} council in Oslo approves harbor plan number ${i}`, { network: 'same-network' }));
    const map = new Map(arts.map((a) => [a.id, a]));
    const clusters = arts.map((a) => ({ ...cluster([a]), id: 'c' + a.id, leadArticleId: a.id }));
    const page = buildLayout(map, clusters, NOW);
    expect(page.layout.world.europe!.length).toBe(2);
  });
});
