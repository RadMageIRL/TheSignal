// The Signal's outgoing RSS 2.0 feeds, built from a published snapshot.
//
// - Only sources whose terms allow redistribution (PublicSource.syndicate) contribute items.
// - Items carry the publisher's headline exactly as collected, a direct link to the original,
//   the original publication time (never invented: undated items have no pubDate), the
//   publisher's name and feed as <source>, and categories. Descriptions contain only The
//   Signal's own metadata (publisher, country, type, outlet counts), never publisher text.
// - Output is deterministic for a given snapshot, so an unchanged feed has unchanged bytes and
//   a stable ETag, and the build time is the snapshot's own time, so a feed served during a
//   collection outage tells the truth about its age.
import type { Article, Cluster, PublicSource, Snapshot } from './types.ts';
import { FEED_LIMITS, FEED_SPECS, feedUrl, type FeedSpec } from './feeds.ts';
import { IDENTITY } from './identity.ts';
import { SECTION_TITLES, SUB_TITLES } from './labels.ts';
import { TYPE_LABEL, countryName } from './countries.ts';
import { safeLink } from './url.ts';
import { NOT_A_COUNTRY, normalizeTitle, pickLead } from './cluster.ts';

const BS = String.fromCharCode(92);
const u = (hex: string) => BS + 'u' + hex;
// Characters XML 1.0 forbids: C0 controls except tab, newline and carriage return; U+FFFE and
// U+FFFF; and unpaired surrogates.
const XML_INVALID = new RegExp(
  '[' + u('0000') + '-' + u('0008') + u('000B') + u('000C') + u('000E') + '-' + u('001F') + u('FFFE') + u('FFFF') + ']'
  + '|[' + u('D800') + '-' + u('DBFF') + '](?![' + u('DC00') + '-' + u('DFFF') + '])'
  + '|(?<![' + u('D800') + '-' + u('DBFF') + '])[' + u('DC00') + '-' + u('DFFF') + ']',
  'g',
);

export function escapeXml(s: string): string {
  return s.replace(XML_INVALID, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** RFC 822 date as RSS 2.0 expects (four-digit year, GMT). */
export function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

export function itemGuid(articleId: string): string {
  return `tag:radmagelabs.com,2026:signal:article:${articleId}`;
}

const BADGE = new Set(['opinion', 'commentary', 'official', 'investigation', 'podcast', 'video']);

export interface RssDocument {
  spec: FeedSpec;
  xml: string;
  items: number;
  bytes: number;
  /** Articles in this feed's scope left out because their publisher does not allow redistribution. */
  excluded: number;
}

export interface RssContext {
  /** The publisher feed an article came from, for the <source url> attribute. */
  feedUrlOf: (sourceId: string) => string | undefined;
  maxItems?: number;
  maxItemsAll?: number;
  maxBytes?: number;
}

interface Entry { a: Article; note: string }

const time = (a: Article) => Date.parse(a.publishedAt ?? a.fetchedAt);
const newestFirst = (x: Article, y: Article) => time(y) - time(x) || (x.id < y.id ? -1 : 1);

/** One item. `link` has already passed safeLink. */
function itemXml(e: Entry, link: string, src: PublicSource, ctx: RssContext): string | null {
  const title = e.a.title.trim();
  if (!title) return null;
  const parts = [
    `<title>${escapeXml(title)}</title>`,
    `<link>${escapeXml(link)}</link>`,
    `<guid isPermaLink="false">${escapeXml(itemGuid(e.a.id))}</guid>`,
  ];
  if (e.a.publishedAt) parts.push(`<pubDate>${rfc822(e.a.publishedAt)}</pubDate>`);
  parts.push(`<description>${escapeXml(e.note)}</description>`);
  const cats = [SECTION_TITLES[e.a.section], SUB_TITLES[e.a.subsection], countryName(e.a.country)];
  if (BADGE.has(e.a.contentType)) cats.push(TYPE_LABEL[e.a.contentType] ?? e.a.contentType);
  for (const c of [...new Set(cats.filter(Boolean))]) parts.push(`<category>${escapeXml(c)}</category>`);
  const from = safeLink(ctx.feedUrlOf(src.id) ?? '');
  if (from) parts.push(`<source url="${escapeXml(from)}">${escapeXml(src.name)}</source>`);
  return `<item>${parts.join('')}</item>`;
}

function describe(a: Article, src: PublicSource): string {
  const type = TYPE_LABEL[a.contentType];
  const notice = src.notice ? ` ${src.notice}` : '';
  return `${src.name}, ${countryName(a.country)}.${type && BADGE.has(a.contentType) ? ` ${type}.` : ''}${notice}`;
}

function storyNote(a: Article, src: PublicSource, arts: Article[]): string {
  const outlets = new Set(arts.map((x) => x.sourceId)).size;
  const countries = [...new Set(arts.map((x) => x.country).filter((c) => !NOT_A_COUNTRY.has(c)))].map(countryName).sort();
  return `${describe(a, src)} One of ${outlets} ${outlets === 1 ? 'outlet' : 'outlets'} in ${countries.length} ${countries.length === 1 ? 'country' : 'countries'} covering this story: ${countries.join(', ')}.`;
}

function channel(spec: FeedSpec, snap: Snapshot, items: string[]): string {
  const title = `The Signal: ${spec.title}`;
  const page = IDENTITY.website + (spec.anchor || '');
  const proto = snap.mode === 'prototype' ? ' Prototype capture for review; not a live feed.' : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n'
    + `<title>${escapeXml(title)}</title>\n`
    + `<link>${escapeXml(page)}</link>\n`
    + `<description>${escapeXml(spec.description + ' Headlines link to their publishers; The Signal hosts no articles.' + proto)}</description>\n`
    + '<language>en</language>\n'
    + `<copyright>${escapeXml('Headlines, names and linked content belong to their publishers. Feed structure by The Signal.')}</copyright>\n`
    + `<lastBuildDate>${rfc822(snap.generatedAt)}</lastBuildDate>\n`
    + '<docs>https://www.rssboard.org/rss-specification</docs>\n'
    + `<generator>${escapeXml(`${IDENTITY.application} ${IDENTITY.version}`)}</generator>\n`
    + `<ttl>${FEED_LIMITS.ttlMinutes}</ttl>\n`
    + `<atom:link href="${escapeXml(feedUrl(spec))}" rel="self" type="application/rss+xml"/>\n`
    + items.map((i) => i + '\n').join('')
    + '</channel>\n</rss>\n';
}

const bytesOf = (s: string) => new TextEncoder().encode(s).length;

function entriesFor(spec: FeedSpec, snap: Snapshot, byId: Map<string, Article>, srcs: Map<string, PublicSource>): { entries: Entry[]; excluded: number } {
  const ok = (a: Article) => srcs.get(a.sourceId)?.syndicate === true;
  if (spec.scope === 'all' || spec.scope === 'section') {
    const scope = snap.articles.filter((a) => spec.scope === 'all' || a.section === spec.section);
    const eligible = scope.filter(ok).sort(newestFirst);
    return { entries: eligible.map((a) => ({ a, note: describe(a, srcs.get(a.sourceId)!) })), excluded: scope.length - eligible.length };
  }
  const ids = spec.scope === 'trending' ? snap.trending : snap.perspectives;
  const clusters = new Map<string, Cluster>(snap.clusters.map((c) => [c.id, c]));
  const entries: Entry[] = [];
  let excluded = 0;
  for (const id of ids) {
    const c = clusters.get(id);
    if (!c) continue;
    const arts = c.articleIds.map((x) => byId.get(x)).filter((a): a is Article => !!a);
    const eligible = arts.filter(ok);
    if (eligible.length === 0) { excluded++; continue; }
    // The story's own lead when its publisher allows redistribution, else the best eligible report.
    const lead = byId.get(c.leadArticleId);
    const pick = lead && ok(lead) ? lead : pickLead(eligible);
    entries.push({ a: pick, note: storyNote(pick, srcs.get(pick.sourceId)!, arts) });
  }
  return { entries, excluded };
}

export function buildFeed(spec: FeedSpec, snap: Snapshot, ctx: RssContext): RssDocument {
  const byId = new Map(snap.articles.map((a) => [a.id, a] as const));
  const srcs = new Map(snap.sources.map((s) => [s.id, s] as const));
  const { entries, excluded } = entriesFor(spec, snap, byId, srcs);
  const cap = spec.scope === 'all' ? (ctx.maxItemsAll ?? FEED_LIMITS.maxItemsAll) : (ctx.maxItems ?? FEED_LIMITS.maxItems);
  const maxBytes = ctx.maxBytes ?? FEED_LIMITS.maxBytes;
  const items: string[] = [];
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  for (const e of entries) {
    if (items.length >= cap) break;
    const link = safeLink(e.a.url);
    const key = normalizeTitle(e.a.title);
    if (!link || seenUrl.has(link) || seenTitle.has(e.a.sourceId + '|' + key)) continue;
    const x = itemXml(e, link, srcs.get(e.a.sourceId)!, ctx);
    if (!x) continue;
    seenUrl.add(link);
    seenTitle.add(e.a.sourceId + '|' + key);
    items.push(x);
  }
  let xml = channel(spec, snap, items);
  while (bytesOf(xml) > maxBytes && items.length > 0) {
    items.pop(); // oldest last in section feeds; lowest-ranked last in story feeds
    xml = channel(spec, snap, items);
  }
  return { spec, xml, items: items.length, bytes: bytesOf(xml), excluded };
}

export function buildAllFeeds(snap: Snapshot, ctx: RssContext): RssDocument[] {
  return FEED_SPECS.map((spec) => buildFeed(spec, snap, ctx));
}
