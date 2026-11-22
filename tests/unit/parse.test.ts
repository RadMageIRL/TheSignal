import { describe, expect, it } from 'vitest';
import { parseXmlFeed, parseMastodonLinks, closeTruncated } from '../../ingest/parse.ts';

const NOW = new Date('2026-11-22T12:00:00Z');

const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Wire</title><link>https://example.org/</link>${items}</channel></rss>`;

describe('RSS 2.0', () => {
  it('reads title, link, date and creator from a well formed item', () => {
    const r = parseXmlFeed(rss(`<item><title>Harbor bridge reopens after repairs</title><link>https://example.org/a/1</link><pubDate>Sun, 22 Nov 2026 10:00:00 GMT</pubDate><dc:creator>Staff</dc:creator></item>`), 'https://example.org/feed', NOW);
    expect(r.format).toBe('rss');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ title: 'Harbor bridge reopens after repairs', link: 'https://example.org/a/1', publishedAt: '2026-11-22T10:00:00.000Z' });
  });

  it('decodes double-encoded entities and strips markup from titles', () => {
    const r = parseXmlFeed(rss(`<item><title>&lt;b&gt;Mayor&lt;/b&gt; says &amp;amp;#8220;no&amp;amp;#8221;</title><link>https://example.org/a/2</link></item>`), 'https://example.org/feed', NOW);
    expect(r.items[0]!.title).toBe('Mayor says “no”');
  });

  it('drops items whose link is not http(s)', () => {
    const r = parseXmlFeed(rss(`<item><title>Bad link</title><link>javascript:alert(1)</link></item><item><title>Good</title><link>https://example.org/ok</link></item>`), 'https://example.org/feed', NOW);
    expect(r.items.map((i) => i.title)).toEqual(['Good']);
  });

  it('refuses documents that declare entities (expansion attacks)', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss><channel><item><title>&b;</title><link>https://example.org/x</link></item></channel></rss>`;
    const r = parseXmlFeed(xml, 'https://example.org/feed', NOW);
    expect(r.items).toHaveLength(0);
    expect(r.problems.join(' ')).toMatch(/entities/);
  });

  it('survives malformed XML without throwing', () => {
    const r = parseXmlFeed('<rss><channel><item><title>Unclosed', 'https://example.org/feed', NOW);
    expect(r.items).toHaveLength(0);
  });

  it('reports a non-feed document instead of inventing items', () => {
    const r = parseXmlFeed('<html><head><title>Off Air</title></head></html>', 'https://example.org/feed', NOW);
    expect(r.items).toHaveLength(0);
    expect(r.problems[0]).toMatch(/not an RSS/);
  });

  it('rejects dates far in the future and keeps the item undated', () => {
    const r = parseXmlFeed(rss(`<item><title>Future</title><link>https://example.org/f</link><pubDate>Wed, 25 Nov 2026 10:00:00 GMT</pubDate></item>`), 'https://example.org/feed', NOW);
    expect(r.items[0]!.publishedAt).toBeNull();
  });

  it('falls back to the channel link for podcast items without links, but not for news', () => {
    const body = rss(`<item><title>Episode 12</title><itunes:duration>1:02:03</itunes:duration></item>`);
    expect(parseXmlFeed(body, 'https://example.org/feed', NOW).items).toHaveLength(0);
    const p = parseXmlFeed(body, 'https://example.org/feed', NOW, { linkFallbackToChannel: true });
    expect(p.items[0]).toMatchObject({ link: 'https://example.org/', durationSec: 3723 });
  });
});

describe('RDF and Atom', () => {
  it('reads RSS 1.0 (RDF) items with dc:date', () => {
    const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>R</title></channel><item rdf:about="https://example.org/r1"><title>Rail strike ends</title><link>https://example.org/r1</link><dc:date>2026-11-22T08:00:00Z</dc:date></item></rdf:RDF>`;
    const r = parseXmlFeed(xml, 'https://example.org/feed', NOW);
    expect(r.format).toBe('rdf');
    expect(r.items[0]).toMatchObject({ title: 'Rail strike ends', publishedAt: '2026-11-22T08:00:00.000Z' });
  });

  it('prefers the alternate link in Atom entries', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>Chip plant approved</title><link rel="self" href="https://example.org/self"/><link rel="alternate" href="https://example.org/story"/><updated>2026-11-22T09:00:00Z</updated></entry></feed>`;
    const r = parseXmlFeed(xml, 'https://example.org/feed', NOW);
    expect(r.items[0]!.link).toBe('https://example.org/story');
  });
});

describe('truncated feeds', () => {
  it('closes a cut-off RSS body after its last complete item', () => {
    const full = rss(`<item><title>One</title><link>https://example.org/1</link></item><item><title>Two</title><link>https://example.org/2</link></item>`);
    // Cut inside a third item: the closing tags are gone and the third item is incomplete.
    const cut = full.replace('</channel></rss>', '<item><title>Thr');
    const r = parseXmlFeed(cut, 'https://example.org/feed', NOW, { truncated: true });
    expect(r.items.map((i) => i.title)).toEqual(['One', 'Two']);
    expect(closeTruncated('<rss><channel><item>x</item><item>half')).toBe('<rss><channel><item>x</item></channel></rss>');
  });

  it('keeps the complete items when the cut lands inside a tag attribute', () => {
    const full = rss(`<item><title>One</title><link>https://example.org/1</link></item>`);
    const cut = full.replace('</channel></rss>', '<item><title>Two</title><enclosure url="https://ex');
    const r = parseXmlFeed(cut, 'https://example.org/feed', NOW, { truncated: true });
    expect(r.items.map((i) => i.title)).toEqual(['One']);
  });

  it('never shows a headline that was cut off mid-word', () => {
    const full = rss(`<item><title>One</title><link>https://example.org/1</link></item>`);
    const cut = full.replace('</channel></rss>', '<item><link>https://example.org/3</link><title>Three people ki');
    const r = parseXmlFeed(cut, 'https://example.org/feed', NOW, { truncated: true });
    expect(r.items.map((i) => i.title)).toEqual(['One']);
  });
});

describe('Mastodon trending links', () => {
  it('keeps link-type entries and sums recent sharing accounts', () => {
    const json = JSON.stringify([
      { type: 'link', title: 'Open data portal launches', url: 'https://example.org/p', provider_name: 'Example', history: [{ accounts: '30' }, { accounts: '12' }, { accounts: '99' }] },
      { type: 'video', title: 'Ignored', url: 'https://example.org/v' },
    ]);
    const r = parseMastodonLinks(json, 'mastodon.example', NOW);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.points).toBe(42);
  });
});
