import { describe, expect, it } from 'vitest';
import type { Article, SectionId, Subsection } from '../../shared/types.ts';
import { effectiveType, headlineLabel, isOpinion, isSponsored } from '../../shared/editorial.ts';
import { buildLayout, SECTION_OF_SUB, scoreCluster } from '../../shared/layout.ts';
import { pickLead } from '../../shared/cluster.ts';

// Dashes as some feeds write them, built from code points so this file stays ASCII.
const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);

describe('a publisher label on a headline', () => {
  it('reads opinion labels at the start or the end of a headline', () => {
    for (const t of [
      'Mr. Speaker, members of the Knesset: Lead by example - opinion',
      'Opinion: The city must fix its buses',
      'OPINION | Why the budget deal will not hold',
      'Op-Ed: A better way to fund schools',
      'Editorial: The council owes residents an answer',
      `Opinion ${EM} The case for a four-day week`,
      `The case for a four-day week ${EN} Opinion`,
      'The case for a four-day week | Opinion',
      'The case for a four-day week (Opinion)',
      '[Opinion] The case for a four-day week',
    ]) expect(headlineLabel(t), t).toBe('opinion');
  });

  it('reads commentary labels the same way', () => {
    expect(headlineLabel('Commentary: Rate cuts will not fix housing')).toBe('commentary');
    expect(headlineLabel('Rate cuts will not fix housing - commentary')).toBe('commentary');
  });

  it('reads sponsored labels, and calls "Sponsored Commentary" sponsored rather than commentary', () => {
    for (const t of [
      'Sponsored Commentary: Immigrant talent powers the American economy',
      'Sponsored: Five ways to save on heating',
      'Sponsored Content | Five ways to save on heating',
      'Paid Post: Five ways to save on heating',
      'Partner Content: Five ways to save on heating',
      'Five ways to save on heating [Sponsored]',
      'Five ways to save on heating (Advertisement)',
    ]) expect(headlineLabel(t), t).toBe('sponsored');
  });

  it('leaves ordinary headlines that only use the words alone', () => {
    for (const t of [
      'Public opinion turns against the harbor plan',
      'Opinion polls show a tight race in the north',
      'Opinion poll: Labour leads by four points',
      'Justices split in a 5-4 majority opinion',
      'Senate passes a bill sponsored by Smith',
      'Sponsored bill clears the committee',
      'Independent media outlets were reportedly blacklisted by government advertising agencies',
      'Editorial staff walk out at the city newspaper',
      'Commentary on the ruling draws criticism from both parties',
      'Advertisement rules tightened for gambling firms',
      'Court strikes down pro-opinion rule',
    ]) expect(headlineLabel(t), t).toBeNull();
  });

  it('marks only sponsored items for leaving out', () => {
    expect(isSponsored('Sponsored Commentary: Immigrant talent powers the American economy')).toBe(true);
    expect(isSponsored('Opinion: The city must fix its buses')).toBe(false);
    expect(isSponsored('Senate passes a bill sponsored by Smith')).toBe(false);
  });

  it('ranks a labeled item from a news feed as opinion, and keeps a source type that is already opinion', () => {
    expect(effectiveType({ title: 'Lead by example - opinion', contentType: 'reporting' })).toBe('opinion');
    expect(effectiveType({ title: 'Commentary: Rates', contentType: 'reporting' })).toBe('commentary');
    expect(effectiveType({ title: 'Harbor reopens after storm', contentType: 'reporting' })).toBe('reporting');
    expect(effectiveType({ title: 'Commentary: Rates', contentType: 'opinion' })).toBe('opinion');
    expect(isOpinion({ title: 'Harbor reopens after storm', contentType: 'commentary' })).toBe(true);
  });
});

const NOW = Date.parse('2026-11-22T20:00:00Z');
let n = 0;
function art(sourceId: string, sub: Subsection, title: string, extra: Partial<Article> = {}): Article {
  n++;
  return {
    id: `e${n}`, sourceId, title, url: `https://${sourceId}.example/${n}`, publishedAt: '2026-11-22T18:00:00Z',
    firstSeenAt: '2026-11-22T18:00:00Z', section: SECTION_OF_SUB[sub] as SectionId, subsection: sub, contentType: 'reporting',
    country: 'GB', language: 'en', ...extra,
  };
}
const single = (a: Article) => ({
  id: `c${a.id}`, articleIds: [a.id], leadArticleId: a.id, sourceCount: 1, countryCount: 1, originCount: 1,
  firstSeen: a.publishedAt!, lastSeen: a.publishedAt!, score: 0,
});

describe('the lead story and opinion labels', () => {
  it('never leads with a headline labeled opinion, even the newest one from a news feed, and keeps it in its column', () => {
    const opinion = art('jp', 'mideast', 'Mr. Speaker, members of the Knesset: Lead by example - opinion', { publishedAt: '2026-11-22T19:59:00Z', country: 'IL' });
    const news = art('wire', 'europe', 'Ferry service to Oslo resumes after the storm', { publishedAt: '2026-11-22T17:00:00Z', country: 'NO' });
    const page = buildLayout(new Map([[opinion.id, opinion], [news.id, news]]), [single(opinion), single(news)], NOW);
    expect(page.leadClusterId).toBe(`c${news.id}`);
    expect(page.layout.world.mideast).toContain(`c${opinion.id}`);
  });

  it('shows no lead at all rather than an opinion piece when nothing else qualifies', () => {
    const opinion = art('jp', 'mideast', 'Opinion: Lead by example', { country: 'IL' });
    const page = buildLayout(new Map([[opinion.id, opinion]]), [single(opinion)], NOW);
    expect(page.leadClusterId).toBeNull();
  });

  it('scores a labeled headline at the opinion discount', () => {
    const plain = art('a', 'national', 'Harbor reopens after storm');
    const labeled = art('b', 'national', 'Harbor reopens after storm - opinion');
    expect(scoreCluster(single(labeled), labeled, NOW) / scoreCluster(single(plain), plain, NOW)).toBeCloseTo(0.6, 5);
  });

  it('represents a story by its reporting rather than by a labeled opinion piece about it', () => {
    const opinion = art('b', 'national', 'Opinion: Harbor plan is a mistake', { publishedAt: '2026-11-22T09:00:00Z' });
    const report = art('a', 'national', 'Harbor plan approved by council', { publishedAt: '2026-11-22T10:00:00Z' });
    expect(pickLead([opinion, report]).id).toBe(report.id);
  });
});
