// Ranking and page layout. Runs at ingest time for the default page, and again in the
// browser when a reader turns sources off, so the same transparent rules apply to both.
//
// Score = recency x (1 + 0.9 log2(1 + independent reports) + 0.5 log2(1 + countries)) x type factor
// - recency halves every 10 hours, measured from the story's newest report;
// - republished wire copy and syndicated copies count once ("independent reports");
// - opinion and commentary lead news columns only at a discount, and never lead the page: by the source's
//   type or by the publisher's own label on the headline (shared/editorial.ts);
// - sports results, advice columns, programming notes and reviews rank lower (shared/topics.ts).
// Diversity caps keep any one publisher or country from flooding a list.

import type { Article, Cluster, SectionId, Snapshot, Subsection } from './types.ts';
import { countOrigins, countryCountOf, pickLead } from './cluster.ts';
import { isUsDomestic, regionOf } from './regions.ts';
import { softFactor } from './topics.ts';
import { effectiveType, isOpinion } from './editorial.ts';

export const HALF_LIFE_HOURS = 10;

const TYPE_FACTOR: Record<string, number> = { opinion: 0.6, commentary: 0.7, official: 0.85 };

export const QUOTAS: Record<SectionId, Partial<Record<Subsection, number>>> = {
  us: { national: 7, washington: 6, law: 4, economy: 4 },
  world: { 'world-general': 4, europe: 6, mideast: 6, asia: 6, 'africa-americas': 6 },
  markets: { 'global-markets': 6, crypto: 4, tech: 6, science: 5 },
  outside: { alternative: 4, independent: 4, investigations: 4, commentary: 4 },
  airwaves: { podcasts: 10, interviews: 0, video: 0 },
  pulse: { discussions: 8, trends: 6, reading: 6 },
};

export const SECTION_SUBS: Record<SectionId, Subsection[]> = {
  us: ['national', 'washington', 'law', 'economy'],
  world: ['world-general', 'europe', 'mideast', 'asia', 'africa-americas'],
  markets: ['global-markets', 'crypto', 'tech', 'science'],
  outside: ['alternative', 'independent', 'investigations', 'commentary'],
  airwaves: ['podcasts', 'interviews', 'video'],
  pulse: ['discussions', 'trends', 'reading'],
};

/** The section each list belongs to (every list belongs to exactly one section). */
export const SECTION_OF_SUB = Object.fromEntries(
  (Object.entries(SECTION_SUBS) as [SectionId, Subsection[]][]).flatMap(([sec, subs]) => subs.map((x) => [x, sec])),
) as Record<Subsection, SectionId>;

export const NEWS_SECTIONS: SectionId[] = ['us', 'world', 'markets'];
export const SECONDARY_SECTIONS: SectionId[] = ['outside', 'airwaves', 'pulse'];
const PULSE_PER_PLATFORM = 5;
const PER_PUBLISHER_PER_LIST = 2;
const PER_COUNTRY_PER_LIST = 3;

const t = (a: Article) => Date.parse(a.publishedAt ?? a.firstSeenAt);

/** Recompute a cluster's counts and lead from the articles that are still visible. */
export function summarizeCluster(base: Cluster, arts: Article[]): Cluster | null {
  if (arts.length === 0) return null;
  const times = arts.map(t);
  const lead = pickLead(arts);
  return {
    ...base,
    articleIds: arts.map((a) => a.id),
    leadArticleId: lead.id,
    sourceCount: new Set(arts.map((a) => a.sourceId)).size,
    countryCount: countryCountOf(arts),
    originCount: countOrigins(arts),
    firstSeen: new Date(Math.min(...times)).toISOString(),
    lastSeen: new Date(Math.max(...times)).toISOString(),
  };
}

export function scoreCluster(c: Cluster, lead: Article, nowMs: number): number {
  const ageH = Math.max(0, (nowMs - Date.parse(c.lastSeen)) / 3600_000);
  const recency = Math.pow(0.5, ageH / HALF_LIFE_HOURS);
  const corroboration = 1 + 0.9 * Math.log2(1 + c.originCount) + 0.5 * Math.log2(1 + c.countryCount);
  return recency * corroboration * (TYPE_FACTOR[effectiveType(lead)] ?? 1) * softFactor(lead.title);
}

/** The region most of a story's headlines name, if any names one. */
export function placeRegion(arts: Pick<Article, 'title'>[]): Subsection | null {
  const votes = new Map<Subsection, number>();
  for (const a of arts) {
    const r = regionOf(a.title);
    if (r) votes.set(r, (votes.get(r) ?? 0) + 1);
  }
  let best: Subsection | null = null;
  let n = 0;
  for (const [r, v] of votes) if (v > n) { best = r; n = v; }
  return best;
}

/**
 * Section and list for a story. The section is the majority section of the outlets that carry it,
 * with two corrections from the headlines themselves:
 * - a story from U.S. outlets that names only a foreign place (and nothing domestic) is world news;
 * - a story from world outlets that names no foreign place but does name U.S. places or
 *   institutions is U.S. news.
 * Within World, where a story happens (the places its headlines name) outranks which regional
 * feed carried it; the feeds' regions decide only when the headlines name no place.
 */
export function placeCluster(c: Cluster, arts: Article[], lead: Article): { section: SectionId; sub: Subsection } {
  const votes = new Map<SectionId, number>();
  for (const a of arts) votes.set(a.section, (votes.get(a.section) ?? 0) + 1);
  let section = lead.section;
  let top = votes.get(section) ?? 0;
  for (const [s, v] of votes) if (v > top) { section = s; top = v; }
  const place = placeRegion(arts);
  const domestic = arts.some((a) => isUsDomestic(a.title));
  if (section === 'us' && place && !domestic) section = 'world';
  if (section === 'world') {
    if (place) return { section, sub: place };
    if (domestic) return { section: 'us', sub: 'national' };
  }
  const inSection = arts.filter((a) => a.section === section);
  const subVotes = new Map<Subsection, number>();
  for (const a of inSection) if (a.subsection !== 'world-general') subVotes.set(a.subsection, (subVotes.get(a.subsection) ?? 0) + 1);
  let sub: Subsection | null = null;
  let best = 0;
  for (const [s, v] of subVotes) if (v > best) { sub = s; best = v; }
  if (sub === null || !(SECTION_SUBS[section] ?? []).includes(sub)) sub = section === 'world' ? 'world-general' : (SECTION_SUBS[section]?.[0] ?? 'national');
  return { section, sub };
}

export interface PageLayout {
  leadClusterId: string | null;
  /** News sections hold cluster ids; outside, airwaves and pulse hold article ids. */
  layout: Snapshot['layout'];
  perspectives: string[];
  trending: string[];
  breaking: string | null;
  clusters: Map<string, Cluster>;
  clusterOf: Map<string, string>;
}

export function buildLayout(articles: Map<string, Article>, clusters: Cluster[], nowMs: number): PageLayout {
  const live = new Map<string, Cluster>();
  const leadOf = new Map<string, Article>();
  const placed = new Map<string, { section: SectionId; sub: Subsection }>();
  for (const base of clusters) {
    const arts = base.articleIds.map((id) => articles.get(id)).filter((a): a is Article => !!a);
    const c = summarizeCluster(base, arts);
    if (!c) continue;
    const lead = articles.get(c.leadArticleId)!;
    c.score = scoreCluster(c, lead, nowMs);
    live.set(c.id, c);
    leadOf.set(c.id, lead);
    placed.set(c.id, placeCluster(c, arts, lead));
  }
  const ranked = [...live.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  // Lead story: the best-scoring news story that at least three independent reports from
  // at least two countries carry within the last 12 hours; otherwise the best news story. A story
  // whose lead headline is opinion or commentary (by source or by its own label) never leads.
  const isNews = (c: Cluster) => NEWS_SECTIONS.includes(placed.get(c.id)!.section) && !isOpinion(leadOf.get(c.id)!);
  const fresh = (c: Cluster, h: number) => nowMs - Date.parse(c.lastSeen) <= h * 3600_000;
  const leadC = ranked.find((c) => isNews(c) && c.originCount >= 3 && c.countryCount >= 2 && fresh(c, 12))
    ?? ranked.find(isNews) ?? null;

  const layout = {} as Snapshot['layout'];
  for (const s of Object.keys(SECTION_SUBS) as SectionId[]) layout[s] = {};
  const used = new Set<string>(leadC ? [leadC.id] : []);

  // News columns list stories (clusters). The secondary sections list individual items,
  // newest first: they are not ranked by corroboration.
  for (const section of NEWS_SECTIONS) {
    for (const sub of SECTION_SUBS[section]) {
      const quota = QUOTAS[section][sub] ?? 0;
      if (quota === 0) continue;
      const list: string[] = [];
      const pub = new Map<string, number>();
      const ctry = new Map<string, number>();
      for (const c of ranked) {
        if (list.length >= quota) break;
        if (used.has(c.id)) continue;
        const p = placed.get(c.id)!;
        if (p.section !== section || p.sub !== sub) continue;
        const lead = leadOf.get(c.id)!;
        const owner = lead.network ?? lead.sourceId;
        if ((pub.get(owner) ?? 0) >= PER_PUBLISHER_PER_LIST) continue;
        if (section === 'world' && (ctry.get(lead.country) ?? 0) >= PER_COUNTRY_PER_LIST) continue;
        list.push(c.id);
        used.add(c.id);
        pub.set(owner, (pub.get(owner) ?? 0) + 1);
        ctry.set(lead.country, (ctry.get(lead.country) ?? 0) + 1);
      }
      layout[section][sub] = list;
    }
  }
  const newestFirst = [...articles.values()].sort((a, b) => t(b) - t(a) || (a.id < b.id ? -1 : 1));
  for (const section of SECONDARY_SECTIONS) {
    const perSection = new Map<string, number>();
    for (const sub of SECTION_SUBS[section]) {
      const quota = QUOTAS[section][sub] ?? 0;
      if (quota === 0) continue;
      const list: string[] = [];
      const pub = new Map<string, number>();
      const titles = new Set<string>();
      for (const a of newestFirst) {
        if (list.length >= quota) break;
        if (a.section !== section || a.subsection !== sub) continue;
        const cap = section === 'airwaves' ? 1 : section === 'pulse' ? PULSE_PER_PLATFORM : PER_PUBLISHER_PER_LIST;
        if ((pub.get(a.sourceId) ?? 0) >= cap) continue;
        if (section === 'outside' && (perSection.get(a.sourceId) ?? 0) >= 2) continue;
        const key = a.title.toLowerCase();
        if (titles.has(key)) continue;
        titles.add(key);
        list.push(a.id);
        pub.set(a.sourceId, (pub.get(a.sourceId) ?? 0) + 1);
        perSection.set(a.sourceId, (perSection.get(a.sourceId) ?? 0) + 1);
      }
      layout[section][sub] = list;
    }
  }

  // Global Perspectives: stories covered from at least three countries.
  const perspectives = ranked
    .filter((c) => c.id !== leadC?.id && isNews(c) && c.countryCount >= 3 && fresh(c, 36))
    .slice(0, 4)
    .map((c) => c.id);

  // Trending: most independent reports in the last six hours (coverage, not popularity).
  const recentCount = (c: Cluster) => c.articleIds
    .map((id) => articles.get(id)!)
    .filter((a) => a && nowMs - t(a) <= 6 * 3600_000).length;
  const trending = [...live.values()]
    .filter((c) => c.id !== leadC?.id && isNews(c) && c.originCount >= 2 && recentCount(c) >= 2)
    .sort((a, b) => recentCount(b) - recentCount(a) || b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, 8)
    .map((c) => c.id);

  // Breaking banner: only for a story that six or more independent reports from three or
  // more countries began carrying within the last three hours.
  const breaking = ranked.find((c) => isNews(c) && c.originCount >= 6 && c.countryCount >= 3
    && nowMs - Date.parse(c.firstSeen) <= 3 * 3600_000 && recentCount(c) >= 5)?.id ?? null;

  const clusterOf = new Map<string, string>();
  for (const c of live.values()) for (const id of c.articleIds) clusterOf.set(id, c.id);
  return { leadClusterId: leadC?.id ?? null, layout, perspectives, trending, breaking, clusters: live, clusterOf };
}
