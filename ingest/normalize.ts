// RawItem (parser output) -> Article (normalized record), plus deduplication.
import { createHash } from 'node:crypto';
import type { Article, FeedEndpoint, SourceEntry } from '../shared/types.ts';
import type { RawItem } from './parse.ts';
import { canonicalUrl } from '../shared/url.ts';
import { normalizeTitle } from '../shared/cluster.ts';

// Wire attribution is detected only where a feed states it: an author field naming the wire,
// a dateline like "WASHINGTON (AP) -", or a trailing "(Reuters)".
const WIRES: [string, RegExp][] = [
  ['AP', /\bAssociated Press\b|\(AP\)/],
  ['Reuters', /\bReuters\b/],
  ['AFP', /\b(AFP|Agence France-Presse)\b/],
  ['dpa', /\(dpa\)/],
  ['ANI', /\(ANI\)/],
  ['PTI', /\(PTI\)|\bPress Trust of India\b/],
  ['Xinhua', /\(Xinhua\)/],
  ['Kyodo', /\(Kyodo\)/],
  ['Yonhap', /\(Yonhap\)/],
  ['Bloomberg', /^Bloomberg\b/],
];

export function detectWire(item: Pick<RawItem, 'creator' | 'summary'>): string | undefined {
  const creator = item.creator ?? '';
  for (const [name, re] of WIRES) if (re.test(creator)) return name;
  const lead = item.summary.slice(0, 140);
  for (const [name, re] of WIRES) {
    if (name === 'Bloomberg') continue;
    if (re.test(lead) && /^[A-Z][A-Za-z .,'-]{1,40}\s*\(|^\(/.test(lead)) return name;
  }
  return undefined;
}

export function articleId(canonical: string): string {
  return createHash('sha1').update(canonical).digest('hex').slice(0, 14);
}

export function toArticle(item: RawItem, source: SourceEntry, feed: FeedEndpoint, firstSeenAt: string): Article {
  const canonical = canonicalUrl(item.link);
  const a: Article = {
    id: articleId(canonical),
    sourceId: source.id,
    title: item.title,
    url: item.link,
    publishedAt: item.publishedAt,
    firstSeenAt,
    section: feed.section ?? source.section,
    subsection: feed.subsection,
    contentType: source.contentType,
    country: source.country,
    language: source.language,
  };
  const wire = detectWire(item);
  if (wire) a.wire = wire;
  if (source.network) a.network = source.network;
  if (source.section === 'airwaves') {
    a.podcast = { show: source.name, durationSec: item.durationSec, guest: item.persons?.[0] };
  }
  if (source.section === 'pulse') {
    a.community = {
      platform: source.name.replace(/\s*\(.*\)$/, ''),
      origin: item.origin ?? new URL(source.homepage).hostname,
      points: item.points,
      comments: item.comments,
      discussionUrl: item.discussionUrl,
    };
  }
  return a;
}

/** Drops repeated URLs and same-source repeated headlines. Keeps the first occurrence. */
export function dedupe(articles: Article[]): { kept: Article[]; removed: number } {
  const byUrl = new Set<string>();
  const bySourceTitle = new Set<string>();
  const kept: Article[] = [];
  for (const a of articles) {
    const k1 = a.id;
    const k2 = a.sourceId + '|' + normalizeTitle(a.title);
    if (byUrl.has(k1) || bySourceTitle.has(k2)) continue;
    byUrl.add(k1);
    bySourceTitle.add(k2);
    kept.push(a);
  }
  return { kept, removed: articles.length - kept.length };
}
