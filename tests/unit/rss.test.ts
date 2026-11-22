import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Article, Snapshot } from '../../shared/types.ts';
import { buildAllFeeds, buildFeed, escapeXml, itemGuid, rfc822 } from '../../shared/rss.ts';
import { FEED_LIMITS, FEED_SPECS, feedUrl } from '../../shared/feeds.ts';
import { fixtureSnapshot } from '../fixtures/news-day.ts';

const spec = (id: string) => FEED_SPECS.find((f) => f.id === id)!;
const ctx = { feedUrlOf: (id: string) => `https://${id}.example/feed.xml` };
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', processEntities: true, htmlEntities: false });

interface Item { title: string; link: string; guid: { '#text': string; '@isPermaLink': string }; pubDate?: string; description: string; category: string | string[]; source?: { '#text': string; '@url': string } }
function items(xml: string): Item[] {
  const doc = parser.parse(xml) as { rss: { channel: { item?: Item | Item[] } } };
  const it = doc.rss.channel.item;
  return it === undefined ? [] : Array.isArray(it) ? it : [it];
}
function channel(xml: string): Record<string, unknown> {
  return (parser.parse(xml) as { rss: { channel: Record<string, unknown> } }).rss.channel;
}

describe('RSS documents', () => {
  it('are well-formed RSS 2.0 with the required channel elements', async () => {
    const snap = await fixtureSnapshot();
    for (const d of buildAllFeeds(snap, ctx)) {
      expect(XMLValidator.validate(d.xml), d.spec.path).toBe(true);
      expect(d.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      const doc = parser.parse(d.xml) as { rss: { '@version': string } };
      expect(doc.rss['@version']).toBe('2.0');
      const ch = channel(d.xml);
      expect(ch.title).toBe(`The Signal: ${d.spec.title}`);
      expect(String(ch.link)).toMatch(/^https:\/\/radmagelabs\.com\/signal\//);
      expect(ch.description).toBeTruthy();
      expect((ch['atom:link'] as Record<string, string>)['@href']).toBe(feedUrl(d.spec));
    }
  });

  it('gives every item a title, a direct publisher link, a stable non-permalink guid, and its publisher as <source>', async () => {
    const snap = await fixtureSnapshot();
    const xml = buildFeed(spec('all'), snap, ctx).xml;
    const byId = new Map(snap.articles.map((a) => [a.id, a]));
    const list = items(xml);
    expect(list.length).toBeGreaterThan(20);
    for (const it of list) {
      const id = it.guid['#text'].split(':').pop()!;
      const a = byId.get(id)!;
      expect(it.guid['@isPermaLink']).toBe('false');
      expect(it.guid['#text']).toBe(itemGuid(a.id));
      expect(it.link).toBe(a.url);
      expect(it.title).toBe(a.title);
      expect(it.source!['#text']).toBe(snap.sources.find((s) => s.id === a.sourceId)!.name);
      expect(it.source!['@url']).toBe(`https://${a.sourceId}.example/feed.xml`);
    }
  });

  it('keeps the same guid for the same article across rebuilds, even when its headline is edited', async () => {
    const a = await fixtureSnapshot();
    const b = await fixtureSnapshot();
    const target = b.articles.find((x) => x.sourceId === 'capitol-ledger')!;
    target.title = target.title + ' (updated)';
    const guidsA = new Map(items(buildFeed(spec('all'), a, ctx).xml).map((i) => [i.link, i.guid['#text']]));
    const guidsB = new Map(items(buildFeed(spec('all'), b, ctx).xml).map((i) => [i.link, i.guid['#text']]));
    expect(guidsB.get(target.url)).toBe(guidsA.get(target.url));
  });

  it('uses the original publication time and leaves pubDate out when the publisher gave none', async () => {
    const snap = await fixtureSnapshot();
    const dated = snap.articles.find((x) => x.sourceId === 'thames-herald')!;
    const undated = snap.articles.find((x) => x.sourceId === 'capitol-ledger' && x.subsection === 'economy')!;
    undated.publishedAt = null;
    const list = items(buildFeed(spec('all'), snap, ctx).xml);
    expect(list.find((i) => i.link === dated.url)!.pubDate).toBe(rfc822(dated.publishedAt!));
    const u = list.find((i) => i.link === undated.url)!;
    expect(u).toBeDefined();
    expect(u.pubDate).toBeUndefined();
  });

  it('dates the feed by its snapshot, not by when it was built, so a feed served during an outage tells its true age', async () => {
    const snap = await fixtureSnapshot();
    snap.generatedAt = '2026-11-20T03:15:00.000Z';
    const first = buildFeed(spec('world'), snap, ctx).xml;
    await new Promise((r) => setTimeout(r, 5));
    const second = buildFeed(spec('world'), snap, ctx).xml;
    expect(channel(first).lastBuildDate).toBe('Fri, 20 Nov 2026 03:15:00 GMT');
    expect(second).toBe(first); // deterministic bytes: unchanged feeds keep their ETag
  });
});

describe('RSS scope and eligibility', () => {
  it('limits a section feed to that section, and the alternative feed to Outside the Mainstream', async () => {
    const snap = await fixtureSnapshot();
    const sectionOf = new Map(snap.articles.map((a) => [a.url, a.section]));
    for (const [id, section] of [['us', 'us'], ['world', 'world'], ['markets', 'markets'], ['alternative', 'outside'], ['airwaves', 'airwaves'], ['pulse', 'pulse']] as const) {
      const list = items(buildFeed(spec(id), snap, ctx).xml);
      expect(list.length, id).toBeGreaterThan(0);
      expect(list.every((i) => sectionOf.get(i.link) === section), id).toBe(true);
    }
  });

  it('never carries an item from a source without redistribution permission, and counts what it left out', async () => {
    const snap = await fixtureSnapshot();
    const blocked = new Set(snap.sources.filter((s) => s.syndicate !== true).map((s) => s.id));
    expect(blocked.has('rhine-post')).toBe(true); // syndication "no"
    expect(blocked.has('ganges-daily')).toBe(true); // syndication "unknown"
    const sourceOf = new Map(snap.articles.map((a) => [a.url, a.sourceId]));
    let excluded = 0;
    for (const d of buildAllFeeds(snap, ctx)) {
      expect(items(d.xml).some((i) => blocked.has(sourceOf.get(i.link)!)), d.spec.path).toBe(false);
      excluded += d.excluded;
    }
    expect(excluded).toBeGreaterThan(0);
  });

  it('treats a source with no syndicate flag at all as not allowed', async () => {
    const snap = await fixtureSnapshot();
    for (const s of snap.sources) delete s.syndicate;
    for (const d of buildAllFeeds(snap, ctx)) expect(d.items, d.spec.path).toBe(0);
  });

  it('represents a story by an eligible report when the lead publisher does not allow redistribution', async () => {
    const snap = await fixtureSnapshot();
    const ocean = snap.clusters.find((c) => snap.perspectives.includes(c.id) && c.articleIds.length === 5)!;
    expect(snap.articles.find((a) => a.id === ocean.leadArticleId)!.sourceId).toBe('rhine-post');
    const list = items(buildFeed(spec('perspectives'), snap, ctx).xml);
    const eligibleUrls = new Set(snap.articles.filter((a) => ocean.articleIds.includes(a.id) && a.sourceId !== 'rhine-post' && a.sourceId !== 'ganges-daily').map((a) => a.url));
    const item = list.find((i) => eligibleUrls.has(i.link));
    expect(item).toBeDefined();
    expect(item!.description).toContain('One of 5 outlets in 5 countries covering this story');
  });

  it('drops a story from story feeds when none of its publishers allows redistribution', async () => {
    const snap = await fixtureSnapshot();
    const blockedAll = new Set(['kiwi-dispatch', 'sakura-shimbun', 'gulf-monitor']);
    for (const s of snap.sources) if (blockedAll.has(s.id)) s.syndicate = false;
    const d = buildFeed(spec('perspectives'), snap, ctx);
    const port = new Set(snap.articles.filter((a) => /Calder Bay/.test(a.title)).map((a) => a.url));
    expect(items(d.xml).some((i) => port.has(i.link))).toBe(false);
    expect(d.excluded).toBeGreaterThanOrEqual(1);
  });

  it('lists each URL once, and one headline per source once', async () => {
    const snap = await fixtureSnapshot();
    const a = snap.articles.find((x) => x.sourceId === 'thames-herald')!;
    snap.articles.push({ ...a, id: 'dupe-url' }, { ...a, id: 'dupe-title', url: a.url + '?v=2' });
    const list = items(buildFeed(spec('all'), snap, ctx).xml);
    expect(list.filter((i) => i.title === a.title).length).toBe(1);
  });

  it('lists a link once even when another source carries it under a different headline', async () => {
    const snap = await fixtureSnapshot();
    const a = snap.articles.find((x) => x.sourceId === 'thames-herald')!;
    snap.articles.push({ ...a, id: 'other-source-same-url', sourceId: 'lagos-mail', title: 'Completely different words about Varnu' });
    const list = items(buildFeed(spec('all'), snap, ctx).xml);
    expect(list.filter((i) => i.link === a.url).length).toBe(1);
  });
});

describe('RSS bounds', () => {
  it('caps the number of items', async () => {
    const snap = await fixtureSnapshot();
    expect(buildFeed(spec('all'), snap, { ...ctx, maxItemsAll: 7 }).items).toBe(7);
    expect(buildFeed(spec('world'), snap, { ...ctx, maxItems: 3 }).items).toBe(3);
    expect(FEED_LIMITS.maxItems).toBeLessThanOrEqual(100);
  });

  it('drops the oldest items to stay under the byte cap and remains valid XML', async () => {
    const snap = await fixtureSnapshot();
    const full = buildFeed(spec('all'), snap, ctx);
    const capped = buildFeed(spec('all'), snap, { ...ctx, maxBytes: Math.floor(full.bytes / 2) });
    expect(capped.bytes).toBeLessThanOrEqual(Math.floor(full.bytes / 2));
    expect(capped.items).toBeLessThan(full.items);
    expect(capped.items).toBeGreaterThan(0);
    expect(XMLValidator.validate(capped.xml)).toBe(true);
    // The newest items survive.
    expect(items(capped.xml)[0]!.link).toBe(items(full.xml)[0]!.link);
  });
});

describe('RSS escaping and hostile content', () => {
  const ctl = (code: number) => String.fromCharCode(code);

  it('escapes the five XML special characters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  it('removes characters XML 1.0 forbids, including unpaired surrogates, and keeps paired ones', () => {
    const emoji = String.fromCodePoint(0x1f4f0);
    const s = `x${ctl(0)}${ctl(8)}${ctl(0x0b)}${ctl(0x1f)}${ctl(0xfffe)}${ctl(0xd800)}y${emoji}\tz`;
    expect(escapeXml(s)).toBe(`xy${emoji}\tz`);
  });

  async function hostile(mut: (a: Article) => void): Promise<{ snap: Snapshot; xml: string; a: Article }> {
    const snap = await fixtureSnapshot();
    const a = snap.articles.find((x) => x.sourceId === 'capitol-ledger')!;
    mut(a);
    return { snap, a, xml: buildFeed(spec('all'), snap, ctx).xml };
  }

  it('keeps markup in a headline as text, never as elements', async () => {
    const { xml, a } = await hostile((x) => { x.title = '<script>alert(1)</script> ]]> <![CDATA[ & </item><item>'; });
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('</item><item>alert');
    expect(items(xml).find((i) => i.link === a.url)!.title).toBe('<script>alert(1)</script> ]]> <![CDATA[ & </item><item>');
  });

  it('leaves out items whose link is not a safe http(s) URL', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'https://user:pw@evil.example/x', 'http://127.0.0.1/x', 'not a url']) {
      const { xml } = await hostile((x) => { x.url = bad; });
      expect(xml, bad).not.toContain(bad.replace(/&/g, '&amp;'));
      expect(XMLValidator.validate(xml)).toBe(true);
    }
  });

  it('leaves out items whose headline is empty after trimming', async () => {
    const { xml, a } = await hostile((x) => { x.title = '   '; });
    expect(items(xml).some((i) => i.link === a.url)).toBe(false);
  });
});

describe('RSS autodiscovery', () => {
  it('index.html links every feed in the catalog with the RSS media type and its title', () => {
    const html = readFileSync('index.html', 'utf8');
    const links = [...html.matchAll(/<link rel="alternate" type="application\/rss\+xml" title="([^"]+)" href="([^"]+)" \/>/g)]
      .map((m) => ({ title: m[1]!.replace(/&amp;/g, '&'), href: m[2]! }));
    expect(links.map((l) => l.href)).toEqual(FEED_SPECS.map((f) => `/signal/${f.path}`));
    expect(links.map((l) => l.title)).toEqual(FEED_SPECS.map((f) => `The Signal: ${f.title}`));
  });

  it('builds one document per catalog entry at unique paths', async () => {
    const docs = buildAllFeeds(await fixtureSnapshot(), ctx);
    expect(docs.map((d) => d.spec.path)).toEqual(FEED_SPECS.map((f) => f.path));
    expect(new Set(docs.map((d) => d.spec.path)).size).toBe(docs.length);
  });
});

describe('RSS licence notices', () => {
  it('appends a source notice to each of its items, and to no other source', async () => {
    const snap = await fixtureSnapshot();
    const src = snap.sources.find((s) => s.id === 'thames-herald')!;
    src.notice = 'Contains public sector information licensed under the Open Government Licence v3.0.';
    const list = items(buildFeed(spec('all'), snap, ctx).xml);
    const theirs = list.filter((i) => i.source!['#text'] === 'Thames Herald');
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((i) => i.description.endsWith(src.notice!))).toBe(true);
    expect(list.filter((i) => i.source!['#text'] !== 'Thames Herald').some((i) => i.description.includes('Open Government Licence'))).toBe(false);
  });
});
