// Compact on-the-wire snapshot format. Fields that every article of a source shares
// (section, content type, country, language) live once on the source; articles carry
// short keys. The browser decodes back into full Article records.
import type { Article, Cluster, Snapshot, Subsection, SourceEntry } from './types.ts';
import { SECTION_OF_SUB, summarizeCluster } from './layout.ts';

export interface WireArticle {
  i: string; s: string; t: string; u: string; p: string | null; b: Subsection;
  /** First seen by The Signal; sent only for items without a publication time. */
  f?: string;
  w?: string; d?: number; g?: string; n?: number; c?: number; x?: string; o?: string;
}
export interface WireCluster { i: string; a: string[]; f: string; l: string }
export interface WireSnapshot {
  v: 1;
  mode: Snapshot['mode'];
  generatedAt: string;
  nextUpdateAt: string | null;
  sources: Snapshot['sources'];
  articles: WireArticle[];
  clusters: WireCluster[];
  leadClusterId: string | null;
  layout: Snapshot['layout'];
  perspectives: string[];
  trending: string[];
  breaking: string | null;
  stats: Snapshot['stats'];
}

export function encodeSnapshot(s: Snapshot): WireSnapshot {
  return {
    v: 1, mode: s.mode, generatedAt: s.generatedAt, nextUpdateAt: s.nextUpdateAt, sources: s.sources,
    articles: s.articles.map((a) => {
      const w: WireArticle = { i: a.id, s: a.sourceId, t: a.title, u: a.url, p: a.publishedAt, b: a.subsection };
      if (a.publishedAt === null) w.f = a.firstSeenAt;
      if (a.wire) w.w = a.wire;
      if (a.podcast?.durationSec) w.d = a.podcast.durationSec;
      if (a.podcast?.guest) w.g = a.podcast.guest;
      if (a.community?.points) w.n = a.community.points;
      if (a.community?.comments) w.c = a.community.comments;
      if (a.community?.discussionUrl) w.x = a.community.discussionUrl;
      if (a.community?.origin) w.o = a.community.origin;
      return w;
    }),
    clusters: s.clusters.map((c) => ({ i: c.id, a: c.articleIds, f: c.firstSeen, l: c.lastSeen })),
    leadClusterId: s.leadClusterId, layout: s.layout, perspectives: s.perspectives, trending: s.trending,
    breaking: s.breaking, stats: s.stats,
  };
}

type SourceMeta = Pick<SourceEntry, 'id' | 'name' | 'section' | 'contentType' | 'country' | 'language' | 'homepage' | 'network'>;

export function decodeArticles(w: WireSnapshot): Map<string, Article> {
  const src = new Map<string, SourceMeta>(w.sources.map((s) => [s.id, s]));
  const out = new Map<string, Article>();
  for (const a of w.articles) {
    const s = src.get(a.s);
    if (!s) continue;
    const art: Article = {
      id: a.i, sourceId: a.s, title: a.t, url: a.u, publishedAt: a.p, firstSeenAt: a.f ?? a.p ?? w.generatedAt,
      section: SECTION_OF_SUB[a.b] ?? s.section, subsection: a.b, contentType: s.contentType, country: s.country, language: s.language,
    };
    if (a.w) art.wire = a.w;
    if (s.network) art.network = s.network;
    if (s.section === 'airwaves') art.podcast = { show: s.name, durationSec: a.d, guest: a.g };
    if (s.section === 'pulse') {
      art.community = { platform: s.name.replace(/\s*\(.*\)$/, ''), origin: a.o ?? new URL(s.homepage).hostname, points: a.n, comments: a.c, discussionUrl: a.x };
    }
    out.set(art.id, art);
  }
  return out;
}

export function decodeClusters(w: WireSnapshot, articles: Map<string, Article>): Cluster[] {
  return w.clusters.map((c) => ({
    id: c.i, articleIds: c.a.filter((id) => articles.has(id)), leadArticleId: c.a[0] ?? '',
    sourceCount: 0, countryCount: 0, originCount: 0, firstSeen: c.f, lastSeen: c.l, score: 0,
  }));
}

/** A full Snapshot rebuilt from its wire form, with each story's counts and lead recomputed. */
export function snapshotFromWire(w: WireSnapshot): Snapshot {
  const articles = decodeArticles(w);
  const clusters = decodeClusters(w, articles)
    .map((c) => summarizeCluster(c, c.articleIds.map((id) => articles.get(id)!)))
    .filter((c): c is Cluster => c !== null);
  return {
    schema: 1, mode: w.mode, generatedAt: w.generatedAt, nextUpdateAt: w.nextUpdateAt, sources: w.sources,
    articles: [...articles.values()], clusters, leadClusterId: w.leadClusterId, layout: w.layout,
    perspectives: w.perspectives, trending: w.trending, breaking: w.breaking, stats: w.stats,
  };
}
