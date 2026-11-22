import { describe, expect, it } from 'vitest';
import type { Article, SectionId, Subsection } from '../../shared/types.ts';
import { clusterArticles, countOrigins, tokenize, normalizeTitle, placesConflict } from '../../shared/cluster.ts';
import { buildLayout, scoreCluster, HALF_LIFE_HOURS } from '../../shared/layout.ts';
import { canonicalUrl, safeLink } from '../../shared/url.ts';
import { dedupe, detectWire } from '../../ingest/normalize.ts';
import { parseRobots, robotsAllows } from '../../ingest/robots.ts';
import { regionOf, isUsDomestic } from '../../shared/regions.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
let n = 0;
function art(p: Partial<Article> & { title: string; sourceId: string }): Article {
  n++;
  return {
    id: p.id ?? `a${n}`, url: p.url ?? `https://${p.sourceId}.example/${n}`, publishedAt: p.publishedAt ?? '2026-11-22T10:00:00Z',
    firstSeenAt: '2026-11-22T12:00:00Z', section: (p.section ?? 'world') as SectionId, subsection: (p.subsection ?? 'world-general') as Subsection,
    contentType: p.contentType ?? 'reporting', country: p.country ?? 'GB', language: 'en', ...p,
  };
}

// A synthetic news day: one story covered widely, plus unrelated filler so that word
// rarity behaves the way it does in a real snapshot.
function newsDay(): Article[] {
  const filler = Array.from({ length: 120 }, (_, i) => art({ sourceId: `filler${i % 9}`, title: `Filler headline ${i} about topic${i} and matter${i}` }));
  return [
    art({ sourceId: 'alpha', country: 'GB', title: 'Ferry capsizes on Lake Varnu, 31 dead' }),
    art({ sourceId: 'bravo', country: 'IN', title: 'At least 31 dead as ferry capsizes on Lake Varnu' }),
    art({ sourceId: 'charlie', country: 'QA', title: 'Lake Varnu ferry disaster: 31 killed after vessel capsizes' }),
    art({ sourceId: 'delta', country: 'CA', title: 'Varnu ferry capsizes, killing 31' }),
    // Different event that shares one distinctive word only.
    art({ sourceId: 'echo', country: 'US', title: 'Varnu province announces new budget for schools' }),
    ...filler,
  ];
}

describe('tokenize', () => {
  it('drops stopwords, dates and day numbers but keeps larger numbers', () => {
    const t = tokenize('On November 20, 2026, the ferry carrying 240 people sank');
    expect(t).toContain('240');
    expect(t).toContain('ferry');
    expect(t).not.toContain('november');
    expect(t).not.toContain('2026');
    expect(t).not.toContain('20');
  });

  it('treats 31 as a possible day of the month and 32 as a real number (chosen boundary)', () => {
    expect(tokenize('31 dead')).not.toContain('31');
    expect(tokenize('32 dead')).toContain('32');
  });

  it('strips agency update markers before comparing', () => {
    expect(normalizeTitle('(2nd LD) Freight train derails near depot')).toBe(normalizeTitle('Freight train derails near depot'));
    expect(normalizeTitle('(URGENT) Minister resigns')).toBe('minister resigns');
  });
});

describe('clustering', () => {
  it('groups differently worded headlines about the same event', () => {
    const arts = newsDay();
    const clusters = clusterArticles(arts);
    const ferry = clusters.find((c) => c.articleIds.includes(arts[0]!.id))!;
    expect(ferry.articleIds).toHaveLength(4);
    expect(ferry.countryCount).toBe(4);
  });

  it('does not merge a different event that shares only one distinctive word', () => {
    const arts = newsDay();
    const clusters = clusterArticles(arts);
    const ferry = clusters.find((c) => c.articleIds.includes(arts[0]!.id))!;
    expect(ferry.articleIds).not.toContain(arts[4]!.id);
  });

  it('needs two distinctive words: one shared rare word plus common words is not enough', () => {
    const filler = Array.from({ length: 60 }, (_, i) => art({ sourceId: `m${i % 7}`, title: `Market item ${i} about stock${i}` }));
    const a = art({ sourceId: 'q1', title: 'Zorblat market' });
    const b = art({ sourceId: 'q2', title: 'Zorblat market rally' });
    const clusters = clusterArticles([a, b, ...filler]);
    expect(clusters.find((x) => x.articleIds.includes(a.id))!.articleIds).toEqual([a.id]);
  });

  it('keeps apart two events that share a place and a topic word but little else', () => {
    const filler = Array.from({ length: 60 }, (_, i) => art({ sourceId: `h${i % 7}`, title: `Background item ${i} on thing${i}` }));
    const a = art({ sourceId: 'r1', title: 'Varnu ferry operator posts record annual profit' });
    const b = art({ sourceId: 'r2', title: 'Varnu ferry capsizes in storm, dozens missing' });
    const clusters = clusterArticles([a, b, ...filler]);
    expect(clusters.find((x) => x.articleIds.includes(a.id))!.articleIds).toEqual([a.id]);
  });

  it('keeps apart a short pair whose similarity falls between the cluster and pair thresholds', () => {
    // Two shared distinctive words out of six: similarity is about 0.30, under the 0.34 pair threshold.
    const filler = Array.from({ length: 60 }, (_, i) => art({ sourceId: `k${i % 7}`, title: `Background item ${i} on thing${i}` }));
    const a = art({ sourceId: 's1', title: 'Varnu ferry operator profit' });
    const b = art({ sourceId: 's2', title: 'Varnu ferry lost in storm' });
    const clusters = clusterArticles([a, b, ...filler]);
    expect(clusters.find((x) => x.articleIds.includes(a.id))!.articleIds).toEqual([a.id]);
  });

  it('does not merge similar headlines about different places', () => {
    const filler = Array.from({ length: 60 }, (_, i) => art({ sourceId: `g${i % 7}`, title: `Background item ${i} on thing${i}` }));
    const a = art({ sourceId: 'p1', title: 'President threatens steep tariffs on Canada over lumber' });
    const b = art({ sourceId: 'p2', title: 'President threatens steep tariffs on Mexico over lumber' });
    const c = art({ sourceId: 'p3', title: 'Steep lumber tariffs threatened against Canada' });
    const clusters = clusterArticles([a, b, c, ...filler]);
    const ca = clusters.find((x) => x.articleIds.includes(a.id))!;
    expect(ca.articleIds).toContain(c.id);
    expect(ca.articleIds).not.toContain(b.id);
  });

  it('reads a nationality adjective and its country as the same place', () => {
    expect(placesConflict(tokenize('Mexican cartel boss arrested'), tokenize('Mexico captures cartel boss'))).toBe(false);
    expect(placesConflict(tokenize('Ukrainian drones hit refinery'), tokenize('Ukraine says drones hit refinery'))).toBe(false);
    expect(placesConflict(tokenize('Canada lumber tariffs'), tokenize('Mexico lumber tariffs'))).toBe(true);
  });

  it('does not merge identical wording published far apart in time', () => {
    const arts = newsDay();
    arts[3] = { ...arts[3]!, publishedAt: '2026-11-18T10:00:00Z' };
    const ferry = clusterArticles(arts).find((c) => c.articleIds.includes(arts[0]!.id))!;
    expect(ferry.articleIds).not.toContain(arts[3]!.id);
  });

  it('does not glue unrelated items that only share a date', () => {
    const filler = Array.from({ length: 80 }, (_, i) => art({ sourceId: `f${i % 7}`, title: `Unrelated item ${i} regarding subject${i}` }));
    const a = art({ sourceId: 'cartoons', title: 'Daily Cartoon, November 20, 2026' });
    const b = art({ sourceId: 'space', title: 'Picture of the day: 2026 November 20' });
    const c = art({ sourceId: 'roundup', title: 'Today in brief - November 20, 2026' });
    const clusters = clusterArticles([a, b, c, ...filler]);
    expect(clusters.find((x) => x.articleIds.includes(a.id))!.articleIds).toEqual([a.id]);
  });

  it('is deterministic for the same input', () => {
    const arts = newsDay();
    expect(clusterArticles(arts)).toEqual(clusterArticles(arts));
  });
});

describe('independent reports', () => {
  it('counts republished wire copy once', () => {
    expect(countOrigins([
      { sourceId: 'a', wire: 'AP', title: 'Court blocks rule' },
      { sourceId: 'b', wire: 'AP', title: 'Court blocks new rule on loans' },
      { sourceId: 'c', title: 'Judges halt lending rule' },
    ])).toBe(2);
  });

  it('counts word-for-word syndicated headlines from different outlets once', () => {
    expect(countOrigins([
      { sourceId: 'a', title: 'Protesters rally for sixth weekend' },
      { sourceId: 'b', title: 'Protesters rally for sixth weekend' },
      { sourceId: 'c', title: 'Sixth weekend of protests draws crowds' },
    ])).toBe(2);
  });

  it('counts several articles from one outlet once', () => {
    expect(countOrigins([
      { sourceId: 'a', title: 'Envoy expelled after plot' },
      { sourceId: 'a', title: 'Two arrested in alleged plot' },
    ])).toBe(1);
  });
});

describe('ranking and layout', () => {
  it('halves a story score after 10 hours, as the methodology page says', () => {
    const lead = art({ sourceId: 's', title: 't' });
    const base = { id: 'c', articleIds: [lead.id], leadArticleId: lead.id, sourceCount: 1, countryCount: 1, originCount: 1, firstSeen: '', lastSeen: new Date(NOW).toISOString(), score: 0 };
    const fresh = scoreCluster(base, lead, NOW);
    const older = scoreCluster({ ...base, lastSeen: new Date(NOW - 10 * 3600_000).toISOString() }, lead, NOW);
    expect(older / fresh).toBeCloseTo(0.5, 5);
    expect(HALF_LIFE_HOURS).toBe(10);
  });

  it('ranks corroborated stories above single reports of the same age', () => {
    const lead = art({ sourceId: 's', title: 't' });
    const base = { id: 'c', articleIds: [lead.id], leadArticleId: lead.id, sourceCount: 1, countryCount: 1, originCount: 1, firstSeen: '', lastSeen: new Date(NOW).toISOString(), score: 0 };
    expect(scoreCluster({ ...base, originCount: 4, countryCount: 3 }, lead, NOW)).toBeGreaterThan(scoreCluster(base, lead, NOW));
  });

  it('caps one publisher at two stories per list', () => {
    const arts = Array.from({ length: 6 }, (_, i) => art({ sourceId: 'flood', section: 'us', subsection: 'national', country: 'US', title: `Distinct story number ${i} on item${i}` }));
    const clusters = clusterArticles(arts);
    const page = buildLayout(new Map(arts.map((a) => [a.id, a])), clusters, NOW);
    const listed = Object.values(page.layout.us).flat();
    expect(listed.length).toBe(2);
  });

  it('lists podcast episodes by article, one per show', () => {
    const eps = [
      art({ sourceId: 'show1', section: 'airwaves', subsection: 'podcasts', contentType: 'podcast', title: 'Ep 2' }),
      art({ sourceId: 'show1', section: 'airwaves', subsection: 'podcasts', contentType: 'podcast', title: 'Ep 1', publishedAt: '2026-11-21T10:00:00Z' }),
      art({ sourceId: 'show2', section: 'airwaves', subsection: 'podcasts', contentType: 'podcast', title: 'Ep 9' }),
    ];
    const page = buildLayout(new Map(eps.map((a) => [a.id, a])), [], NOW);
    expect(page.layout.airwaves.podcasts).toEqual([eps[0]!.id, eps[2]!.id]);
  });
});

describe('URLs', () => {
  it('canonicalizes tracking parameters, hosts and trailing slashes for dedupe', () => {
    expect(canonicalUrl('http://www.Example.org/news/story/?utm_source=x&id=7&fbclid=y#top'))
      .toBe('https://example.org/news/story?id=7');
  });
  it('rejects unsafe links', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pw@example.org/', 'http://127.0.0.1/', 'http://localhost/a', 'ftp://example.org/']) {
      expect(safeLink(bad)).toBeNull();
    }
    expect(safeLink('/rel/path', 'https://example.org/feed')).toBe('https://example.org/rel/path');
  });
  it('dedupes the same URL and the same headline from one source', () => {
    const a = art({ id: 'x1', sourceId: 'a', title: 'Same story' });
    const b = art({ id: 'x1', sourceId: 'b', title: 'Other wording' });
    const c = art({ id: 'x3', sourceId: 'a', title: '(LEAD) Same story' });
    const r = dedupe([a, b, c]);
    expect(r.kept.map((x) => x.id)).toEqual(['x1']);
    expect(r.removed).toBe(2);
  });
});

describe('wire detection', () => {
  it('reads a dateline credit or an author field, not a passing mention', () => {
    expect(detectWire({ summary: 'WASHINGTON (AP) - The court ruled', creator: undefined })).toBe('AP');
    expect(detectWire({ summary: 'Text', creator: 'Reuters' })).toBe('Reuters');
    expect(detectWire({ summary: 'Analysts told reporters that Reuters had it first', creator: undefined })).toBeUndefined();
  });
});

describe('robots.txt', () => {
  const txt = 'User-agent: *\nDisallow: /api/\nAllow: /api/v1/rss-outbound-feed\nDisallow: /*.php$\n\nUser-agent: GoodBot\nDisallow: /';
  const groups = parseRobots(txt);
  it('lets the longer Allow rule win', () => {
    expect(robotsAllows(groups, 'FeedValidator', '/api/v1/rss-outbound-feed?x=1').allowed).toBe(true);
    expect(robotsAllows(groups, 'FeedValidator', '/api/other').allowed).toBe(false);
  });
  it('honors end anchors and specific agent groups', () => {
    expect(robotsAllows(groups, 'FeedValidator', '/x.php').allowed).toBe(false);
    expect(robotsAllows(groups, 'FeedValidator', '/x.php?y').allowed).toBe(true);
    expect(robotsAllows(groups, 'GoodBot/1.0', '/anything').allowed).toBe(false);
  });
});

describe('regions', () => {
  it('places general world headlines by place names', () => {
    expect(regionOf('Talks resume in Kyiv as Moscow signals pause')).toBe('europe');
    expect(regionOf('Monsoon floods hit Dhaka')).toBe('asia');
    expect(regionOf('Plan for Thanksgiving turkey prices')).toBeNull();
  });
  it('recognizes U.S. domestic stories that arrive through world feeds', () => {
    expect(isUsDomestic('Florida surgeon sentenced in murder case')).toBe(true);
    expect(isUsDomestic('Ferry capsizes on Lake Varnu')).toBe(false);
  });
});
