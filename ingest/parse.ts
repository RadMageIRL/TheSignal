// Feed parsers: RSS 2.0, RSS 1.0 (RDF), Atom, plus small JSON adapters.
// Input is untrusted. Parsers never throw for bad content; they return what they can and a
// list of problems, so one broken feed cannot break a run.
import { XMLParser } from 'fast-xml-parser';
import { cleanText, parseFeedDate, parseDuration } from '../shared/text.ts';
import { safeLink } from '../shared/url.ts';

export interface RawItem {
  title: string;
  link: string;
  guid?: string;
  publishedAt: string | null;
  /** Kept in memory for clustering and wire detection only; never published. */
  summary: string;
  creator?: string;
  durationSec?: number;
  persons?: string[];
  points?: number;
  comments?: number;
  discussionUrl?: string;
  origin?: string;
}

export interface ParseResult {
  format: 'rss' | 'rdf' | 'atom' | 'json' | 'unknown';
  feedTitle: string;
  items: RawItem[];
  problems: string[];
}

const MAX_ITEMS = 60;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['item', 'entry', 'link', 'category', 'podcast:person', 'enclosure'].includes(name),
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return String(o['#text'] ?? '');
    return '';
  }
  return String(v);
}

function atomLink(links: unknown[]): string {
  let alt = '';
  for (const l of links) {
    if (typeof l === 'string') { alt ||= l; continue; }
    const o = l as Record<string, unknown>;
    const rel = String(o['@_rel'] ?? 'alternate');
    const href = String(o['@_href'] ?? '');
    if (rel === 'alternate' && href) return href;
    if (!alt && href && rel !== 'self' && rel !== 'enclosure') alt = href;
  }
  return alt;
}

export interface XmlFeedOptions {
  /** The body was cut short on purpose: close it after the last complete item. */
  truncated?: boolean;
  /** Podcast feeds often omit per-episode links: fall back to the show's own page. */
  linkFallbackToChannel?: boolean;
  /** Last resort for podcast items without any link: the show's own homepage from the registry. */
  fallbackLink?: string;
}

/** Close a deliberately truncated RSS/Atom document after its last complete item. */
export function closeTruncated(xml: string): string {
  const item = xml.lastIndexOf('</item>');
  const entry = xml.lastIndexOf('</entry>');
  if (item < 0 && entry < 0) return xml;
  if (item >= entry) {
    const isRdf = /<rdf:RDF/i.test(xml.slice(0, 2000));
    return xml.slice(0, item + 7) + (isRdf ? '</rdf:RDF>' : '</channel></rss>');
  }
  return xml.slice(0, entry + 8) + '</feed>';
}

export function parseXmlFeed(xml: string, feedUrl: string, now: Date, opts: XmlFeedOptions = {}): ParseResult {
  const problems: string[] = [];
  if (opts.truncated) xml = closeTruncated(xml);
  const out: ParseResult = { format: 'unknown', feedTitle: '', items: [], problems };
  // Entity-expansion and external-entity defense: feeds have no business declaring entities.
  if (/<!ENTITY/i.test(xml.slice(0, 4096))) {
    problems.push('document declares XML entities; refused');
    return out;
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    problems.push('xml parse error: ' + (e instanceof Error ? e.message.slice(0, 120) : 'unknown'));
    return out;
  }
  const rss = doc['rss'] as Record<string, unknown> | undefined;
  const rdf = doc['rdf:RDF'] as Record<string, unknown> | undefined;
  const feed = doc['feed'] as Record<string, unknown> | undefined;

  let rawItems: Record<string, unknown>[] = [];
  let channelLink = '';
  if (rss) {
    out.format = 'rss';
    const channel = (Array.isArray(rss['channel']) ? rss['channel'][0] : rss['channel']) as Record<string, unknown> | undefined;
    out.feedTitle = cleanText(text(channel?.['title']), 200);
    channelLink = text(asArray(channel?.['link'] as unknown[])[0]);
    rawItems = asArray(channel?.['item'] as Record<string, unknown>[]);
  } else if (rdf) {
    out.format = 'rdf';
    const channel = rdf['channel'] as Record<string, unknown> | undefined;
    out.feedTitle = cleanText(text(channel?.['title']), 200);
    rawItems = asArray(rdf['item'] as Record<string, unknown>[]);
  } else if (feed) {
    out.format = 'atom';
    out.feedTitle = cleanText(text(feed['title']), 200);
    rawItems = asArray(feed['entry'] as Record<string, unknown>[]);
  } else {
    problems.push('not an RSS, RDF or Atom document');
    return out;
  }

  for (const it of rawItems.slice(0, MAX_ITEMS)) {
    const title = cleanText(text(it['title']), 300);
    let link = '';
    if (out.format === 'atom') {
      link = atomLink(asArray(it['link'] as unknown[]));
    } else {
      const l = asArray(it['link'] as unknown[]);
      link = text(l[0]) || String((l[0] as Record<string, unknown> | undefined)?.['@_href'] ?? '');
      if (!link && it['guid']) {
        const g = it['guid'] as Record<string, unknown> | string;
        const perma = typeof g === 'object' ? String(g['@_isPermaLink'] ?? 'true') : 'true';
        if (perma !== 'false') link = text(g);
      }
      if (!link && it['@_rdf:about']) link = String(it['@_rdf:about']);
    }
    if (!link && opts.linkFallbackToChannel) link = channelLink || opts.fallbackLink || '';
    const safe = safeLink(link, feedUrl);
    if (!title || !safe) {
      problems.push('item skipped: ' + (!title ? 'no title' : 'no safe link'));
      continue;
    }
    const dateRaw = it['pubDate'] ?? it['dc:date'] ?? it['published'] ?? it['updated'] ?? it['a10:updated'];
    const persons = asArray(it['podcast:person'] as unknown[])
      .map((p) => {
        const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
        const role = String(o['@_role'] ?? 'host').toLowerCase();
        return role === 'guest' ? cleanText(text(p), 80) : '';
      })
      .filter(Boolean);
    const comments = cleanText(text(it['comments']), 400);
    out.items.push({
      title,
      link: safe,
      guid: cleanText(text(it['guid'] ?? it['id']), 400) || undefined,
      publishedAt: parseFeedDate(text(dateRaw), now),
      summary: cleanText(text(it['description'] ?? it['summary'] ?? it['content:encoded'] ?? it['content']), 600),
      creator: cleanText(text(it['dc:creator'] ?? it['author']), 120) || undefined,
      durationSec: parseDuration(text(it['itunes:duration'])),
      persons: persons.length ? persons : undefined,
      discussionUrl: safeLink(comments) ?? undefined,
    });
  }
  if (rawItems.length === 0) problems.push('feed has no items');
  return out;
}

// --- JSON adapters -------------------------------------------------------------

/** Mastodon GET /api/v1/trends/links: links being shared widely on one server. */
export function parseMastodonLinks(json: string, origin: string, now: Date): ParseResult {
  const out: ParseResult = { format: 'json', feedTitle: `Trending links on ${origin}`, items: [], problems: [] };
  let data: unknown;
  try { data = JSON.parse(json); } catch { out.problems.push('json parse error'); return out; }
  if (!Array.isArray(data)) { out.problems.push('unexpected shape'); return out; }
  for (const l of data.slice(0, 20)) {
    const o = (l ?? {}) as Record<string, unknown>;
    const title = cleanText(o['title'], 300);
    const link = safeLink(o['url']);
    if (!title || !link || o['type'] !== 'link') continue;
    const hist = Array.isArray(o['history']) ? (o['history'] as Record<string, unknown>[]) : [];
    const accounts = hist.slice(0, 2).reduce((n, h) => n + (Number(h['accounts']) || 0), 0);
    out.items.push({
      title,
      link,
      publishedAt: parseFeedDate(o['published_at'], now),
      summary: '',
      creator: cleanText(o['provider_name'], 120) || undefined,
      points: accounts || undefined,
      origin,
    });
  }
  return out;
}

/** Wikimedia pageviews "top" endpoint: most-read articles on a given day. */
export function parseWikipediaTop(json: string, project: string, now: Date): ParseResult {
  const out: ParseResult = { format: 'json', feedTitle: `Most read on ${project}`, items: [], problems: [] };
  let data: unknown;
  try { data = JSON.parse(json); } catch { out.problems.push('json parse error'); return out; }
  const items = ((data as Record<string, unknown>)?.['items'] as Record<string, unknown>[] | undefined)?.[0];
  const articles = (items?.['articles'] as Record<string, unknown>[] | undefined) ?? [];
  const day = `${items?.['year']}-${items?.['month']}-${items?.['day']}`;
  // Non-article namespaces, the placeholder "-", and adult sites that bot traffic keeps at the top.
  const skip = /^(Main_Page$|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|User:|-$|Pornhub|XHamster|XVideos|XNXX|.*\bporn)/i;
  for (const a of articles) {
    const t = String(a['article'] ?? '');
    if (!t || skip.test(t)) continue;
    const link = safeLink(`https://${project}/wiki/${encodeURIComponent(t)}`);
    if (!link) continue;
    out.items.push({
      title: cleanText(t.replace(/_/g, ' '), 200),
      link,
      publishedAt: parseFeedDate(`${day}T23:59:00Z`, now),
      summary: '',
      points: Number(a['views']) || undefined,
      origin: project,
    });
    if (out.items.length >= 15) break;
  }
  return out;
}
