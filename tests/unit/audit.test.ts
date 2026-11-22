import { describe, expect, it } from 'vitest';
import type { SourceEntry } from '../../shared/types.ts';
import { auditLedger } from '../../tools/collect-local.ts';
import { emptyState } from '../../ingest/state.ts';
import { DEFAULT_USER_AGENT } from '../../shared/identity.ts';
import { fixtureSources } from '../fixtures/news-day.ts';

// The local smoke test stops at the first violation this audit finds, so each rule is shown
// here to catch a planted violation, and a clean ledger is shown to pass.
const T = Date.parse('2026-11-22T12:00:00Z');
const MIN = 60_000;

function source(id: string, host: string, intervalMinutes: number): SourceEntry {
  const base = fixtureSources()[0]!;
  return { ...base, id, homepage: `https://${host}/`, intervalMinutes, feeds: [{ url: `https://${host}/feed.xml`, kind: 'rss', subsection: base.feeds[0]!.subsection }] };
}
const SOURCES = [source('a', 'a.example', 15), source('b', 'slow.example', 30)];

function state() {
  const s = emptyState(new Date(T));
  s.robots['https://a.example'] = { fetchedAt: new Date(T).toISOString(), policy: { kind: 'none', status: 404 } };
  s.robots['https://slow.example'] = { fetchedAt: new Date(T).toISOString(), policy: { kind: 'rules', status: 200, groups: [{ agents: ['*'], rules: [{ allow: false, pattern: '/private' }], crawlDelay: 10 }] } };
  return s;
}

type Line = Parameters<typeof auditLedger>[0][number];
function req(run: number, url: string, at: number, status = 200, extra: Partial<Line> = {}): Line[] {
  const base = { run, url, target: url, hop: 0, sentAt: at, userAgent: DEFAULT_USER_AGENT, ...extra };
  return [{ ...base, phase: 'sent' }, { ...base, phase: 'done', status, ms: 5 }];
}
const run = (n: number, status = 'publish') => ({ run: n, status }) as Parameters<typeof auditLedger>[1][number];

function clean(): Line[] {
  return [
    ...req(1, 'https://a.example/robots.txt', T, 404),
    ...req(1, 'https://a.example/feed.xml', T + 1000),
    ...req(1, 'https://slow.example/robots.txt', T),
    ...req(1, 'https://slow.example/feed.xml', T + 11_500),
    ...req(2, 'https://a.example/feed.xml', T + 15 * MIN + 1000),
  ];
}
const rules = (ledger: Line[], runs = [run(1), run(2)]) => auditLedger(ledger, runs, SOURCES, state(), 1).map((v) => v.rule);

describe('request audit', () => {
  it('passes a ledger that follows every rule', () => {
    expect(auditLedger(clean(), [run(1), run(2)], SOURCES, state(), 1)).toEqual([]);
  });

  it('catches a feed requested before robots.txt was read', () => {
    expect(rules([...req(1, 'https://a.example/feed.xml', T - 1000), ...clean()])).toContain('robots.txt first');
  });

  it('treats a redirect followed while reading robots.txt as part of reading it', () => {
    const hop = req(1, 'https://a.example/robots.txt', T + 30_000, 404).map((e) => ({ ...e, hop: 1, target: 'https://slow.example/robots-moved.txt' }));
    expect(rules([...clean(), ...hop])).toEqual([]);
  });

  it('catches a path robots.txt disallows', () => {
    expect(rules([...clean(), ...req(1, 'https://slow.example/private', T + 30_000)])).toContain('robots.txt rules');
  });

  it('catches requests closer together than the Crawl-delay', () => {
    expect(rules([...clean().filter((e) => !e.url.includes('slow.example/feed')), ...req(1, 'https://slow.example/feed.xml', T + 5000)])).toContain('Crawl-delay');
  });

  it('catches a feed polled before its interval passed', () => {
    expect(rules([...clean(), ...req(3, 'https://a.example/feed.xml', T + 20 * MIN)], [run(1), run(2), run(3)])).toContain('polling interval');
  });

  it('catches hosts off the allowlist, undeclared identities and unknown feeds', () => {
    const r = rules([...clean(), ...req(1, 'https://evil.example/x', T + 2000), ...req(2, 'https://a.example/other.xml', T + 16 * MIN, 200, { userAgent: 'Mozilla/5.0' })]);
    expect(r).toEqual(expect.arrayContaining(['allowlist', 'declared identity', 'unexpected request']));
  });

  it('catches any request in a run that was refused', () => {
    expect(rules([...clean(), ...req(3, 'https://a.example/feed.xml', T + 40 * MIN)], [run(1), run(2), run(3, 'too-soon')])).toContain('no requests in a refused run');
  });

  it('catches a request to an origin within a day of its 429', () => {
    const ledger = [...clean().filter((e) => e.run === 1), ...req(1, 'https://a.example/feed.xml', T + 2000, 429).map((e) => ({ ...e, url: 'https://a.example/feed.xml' }))];
    expect(rules([...ledger, ...req(2, 'https://a.example/feed.xml', T + 15 * MIN + 3000)])).toContain('cool-down');
  });

  it('catches more attempts in one run than the retry limit allows', () => {
    expect(rules([...clean(), ...req(2, 'https://a.example/feed.xml', T + 15 * MIN + 2000), ...req(2, 'https://a.example/feed.xml', T + 15 * MIN + 3000)])).toContain('retries');
  });

  it('catches robots.txt read again within a day of a usable answer', () => {
    expect(rules([...clean(), ...req(2, 'https://a.example/robots.txt', T + 15 * MIN, 404)])).toContain('robots.txt cache');
  });

  it('allows robots.txt to be read again after an answer the collector could not use, such as a redirect it did not follow', () => {
    const ledger = [
      ...req(1, 'https://slow.example/robots.txt', T, 302),
      ...req(2, 'https://slow.example/robots.txt', T + 30 * MIN, 200),
      ...req(2, 'https://slow.example/feed.xml', T + 30 * MIN + 11_500),
    ];
    expect(rules(ledger)).toEqual([]);
  });
});
