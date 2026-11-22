import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceEntry } from '../../shared/types.ts';
import { fetchFeed, type FetchOptions, type FetchOutcome, type RequestEvent } from '../../ingest/fetch.ts';
import { DEFAULT_CONTROLS, type Controls } from '../../ingest/controls.ts';
import { runCollection, rssProblems, type RunOutcome } from '../../ingest/publish.ts';
import { collect, runOptionsFrom, type Fetcher } from '../../ingest/run.ts';
import { decodeState, emptyState, FileStateStore, INTERVAL_MARGIN_MS, type CollectorState, type StateStore } from '../../ingest/state.ts';
import { DirSiteStore, deliver } from '../../ingest/storage.ts';
import { snapshotFromWire, type WireSnapshot } from '../../shared/wire.ts';
import { buildAllFeeds } from '../../shared/rss.ts';
import { CRAWL_DELAY_MARGIN_MS } from '../../ingest/robots.ts';
import { fixtureSources } from '../fixtures/news-day.ts';

const T0 = Date.parse('2026-11-22T12:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One source per id, each on its own host unless `host` says otherwise. */
function source(id: string, intervalMinutes: number, host = `${id}.example`, path = '/feed.xml'): SourceEntry {
  const base = fixtureSources()[0]!;
  return { ...base, id, name: id, homepage: `https://${host}/`, intervalMinutes, feeds: [{ url: `https://${host}${path}`, kind: 'rss', subsection: base.feeds[0]!.subsection }] };
}

interface Item { n: number; date?: number | null }
function rssOf(host: string, items: Item[]): string {
  const body = items.map((i) => `<item><title>Report ${i.n} from ${host} on the harbor works</title><link>https://${host}/news/${i.n}</link>`
    + (i.date != null ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : '') + '</item>').join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${host}</title><link>https://${host}/</link>${body}</channel></rss>`;
}
const ok = (url: string, body: string, extra: Partial<FetchOutcome> = {}): FetchOutcome =>
  ({ url, finalUrl: url, status: 200, ok: true, notModified: false, body, bytes: body.length, ms: 1, ...extra });
const answer = (url: string, status: number, extra: Partial<FetchOutcome> = {}): FetchOutcome =>
  ({ url, finalUrl: url, status, ok: status === 304, notModified: status === 304, body: '', bytes: 0, ms: 1, error: status === 304 ? undefined : `HTTP ${status}`, ...extra });

/**
 * A fake clock and network. Every request is recorded with the fake time it was sent. robots.txt
 * is answered 404 (no file) unless `robots` gives a body for the host.
 */
function world(feedAnswer: (url: string, o: FetchOptions, t: number) => FetchOutcome, robots: Record<string, string> = {}) {
  const c = { t: T0, sleeps: [] as number[] };
  const calls: { url: string; at: number; o: FetchOptions }[] = [];
  const fetcher: Fetcher = async (url, _p, o) => {
    calls.push({ url, at: c.t, o });
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return robots[u.host] ? ok(url, robots[u.host]!) : answer(url, 404);
    return feedAnswer(url, o, c.t);
  };
  const deps = (store?: StateStore) => ({ fetcher, store, clock: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms; } });
  const feedCalls = (host?: string) => calls.filter((x) => !x.url.endsWith('/robots.txt') && (!host || new URL(x.url).host === host));
  return { c, calls, feedCalls, deps, at: (ms: number) => { c.t = ms; return new Date(ms); } };
}

class MemoryStore implements StateStore {
  text?: string;
  saves: CollectorState[] = [];
  /** Saves from this count on fail (the process "dies" before writing). */
  failFrom = Infinity;
  async load(now: Date) { return this.text === undefined ? { state: emptyState(now), fresh: true } : decodeState(this.text); }
  async save(s: CollectorState) {
    if (this.saves.length >= this.failFrom) throw new Error('disk full');
    this.text = JSON.stringify(s);
    this.saves.push(JSON.parse(this.text) as CollectorState);
  }
}

const on = (over: Partial<Controls> = {}): Controls => ({ ...DEFAULT_CONTROLS, ingest: true, retryDelayMs: 0, minArticles: 1, concurrency: 1, ...over });
const steady = (url: string) => ok(url, rssOf(new URL(url).host, [{ n: 1, date: T0 - 60 * MIN }, { n: 2, date: T0 - 90 * MIN }]));
const shown = (r: RunOutcome, sourceId: string) => (r.status === 'publish' ? JSON.parse(r.snapshotJson) as WireSnapshot : null)?.articles.filter((a) => a.s === sourceId) ?? [];

describe('polling intervals', () => {
  it('requests a feed only once its interval has passed and shows its stored items in between', async () => {
    const w = world(steady);
    const store = new MemoryStore();
    const srcs = [source('fast', 15), source('slow', 30)];
    await runCollection(srcs, on(), w.at(T0), w.deps(store));
    const r2 = await runCollection(srcs, on(), w.at(T0 + 15 * MIN), w.deps(store));
    expect(w.feedCalls('slow.example')).toHaveLength(1);
    expect(w.feedCalls('fast.example')).toHaveLength(2);
    expect(r2.status).toBe('publish');
    if (r2.status !== 'publish') return;
    expect(shown(r2, 'slow')).toHaveLength(2);
    expect(r2.health.find((h) => h.sourceId === 'slow')).toMatchObject({ status: 'not-due', ok: true });
    expect(r2.traffic.notDue).toBe(1);
    await runCollection(srcs, on(), w.at(T0 + 30 * MIN), w.deps(store));
    // Each poll waits out the interval plus the margin, counted from the previous poll's send time.
    const M = INTERVAL_MARGIN_MS;
    expect(w.feedCalls('slow.example').map((x) => x.at)).toEqual([T0, T0 + 30 * MIN + M]);
    expect(w.feedCalls('fast.example').map((x) => x.at)).toEqual([T0, T0 + 15 * MIN + M, T0 + 30 * MIN + 2 * M]);
  });

  it('waits inside a run for a feed that falls due seconds later, and never requests it early', async () => {
    const w = world(steady);
    const store = new MemoryStore();
    const srcs = [source('fast', 15)];
    await runCollection(srcs, on(), w.at(T0), w.deps(store));
    await runCollection(srcs, on(), w.at(T0 + 15 * MIN - 20_000), w.deps(store));
    // 20 s until the interval passes, plus the 1 s margin.
    expect(w.c.sleeps).toContain(21_000);
    expect(w.feedCalls().map((x) => x.at)).toEqual([T0, T0 + 15 * MIN + INTERVAL_MARGIN_MS]);
    const early = await runCollection(srcs, on(), w.at(T0 + 30 * MIN - 45_000), w.deps(store));
    expect(w.feedCalls()).toHaveLength(2);
    expect(early.status === 'publish' && early.health[0]!.status).toBe('not-due');
  });

  it('counts the interval from when the request actually left, after the DNS check', async () => {
    const w = world(steady);
    const store = new MemoryStore();
    const fetcher: Fetcher = async (url, p, o) => {
      // The network layer reports the real send time, 250 ms after the collector asked (a slow DNS lookup).
      if (!url.endsWith('/robots.txt')) p.observe?.({ phase: 'sent', url, target: url, hop: 0, sentAt: w.c.t + 250, userAgent: 'x' });
      return w.deps().fetcher(url, p, o);
    };
    await runCollection([source('fast', 15)], on(), w.at(T0), { ...w.deps(store), fetcher });
    expect(JSON.parse(store.text!).feeds['fast https://fast.example/feed.xml'].lastRequestAt).toBe('2026-11-22T12:00:00.250Z');
  });

  it('keeps the schedule across a restart, reading it back from the saved file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-state-'));
    const w = world(steady);
    const srcs = [source('fast', 15)];
    await runCollection(srcs, on(), w.at(T0), w.deps(new FileStateStore(join(dir, 'state.json'))));
    // A new process: nothing in memory, only the file.
    const later = await runCollection(srcs, on(), w.at(T0 + 12 * MIN), w.deps(new FileStateStore(join(dir, 'state.json'))));
    expect(later.status).toBe('publish');
    expect(w.feedCalls()).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('refuses a run that starts less than ten minutes after the previous one, before any request', async () => {
    const w = world(steady);
    const store = new MemoryStore();
    await runCollection([source('fast', 15)], on(), w.at(T0), w.deps(store));
    const n = w.calls.length;
    const r = await runCollection([source('fast', 15)], on(), w.at(T0 + 9 * MIN), w.deps(store));
    expect(r.status).toBe('too-soon');
    expect(w.calls.length).toBe(n);
  });

  it('refuses to run when the saved state is unreadable, before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-state-'));
    writeFileSync(join(dir, 'state.json'), '{"version":1,"feeds":');
    const w = world(steady);
    const r = await runCollection([source('fast', 15)], on(), w.at(T0), w.deps(new FileStateStore(join(dir, 'state.json'))));
    expect(r.status).toBe('suspended');
    expect(r.reasons[0]).toMatch(/unreadable/);
    expect(w.calls).toHaveLength(0);
  });

  it('refuses a saved state that parses but is malformed', async () => {
    const store = new MemoryStore();
    store.text = JSON.stringify({ ...emptyState(new Date(T0)), feeds: { 'x https://x.example/': { failures: 'many', items: [] } } });
    const w = world(steady);
    const r = await runCollection([source('fast', 15)], on(), w.at(T0), w.deps(store));
    expect(r.status).toBe('suspended');
    expect(w.calls).toHaveLength(0);
  });

  it('saves reservations before the first request, and honors them when a run did not finish', async () => {
    const w = world(steady);
    const store = new MemoryStore();
    const srcs = [source('fast', 15)];
    await runCollection(srcs, on(), w.at(T0), w.deps(store));
    // The next run "dies" after sending its requests: its reservation copy is saved, its final state is not.
    store.failFrom = store.saves.length + 1;
    const r = await runCollection(srcs, on(), w.at(T0 + 15 * MIN), w.deps(store));
    expect(r.status).toBe('kept-last-good');
    expect(r.reasons[0]).toMatch(/could not be saved/);
    store.failFrom = Infinity;
    const reservation = store.saves.at(-1)!;
    expect(reservation.inFlight).toBeDefined();
    const until = Date.parse(reservation.inFlight!.until);
    expect(until).toBeGreaterThan(T0 + 15 * MIN);
    expect(reservation.feeds['fast https://fast.example/feed.xml']!.lastRequestAt).toBe(iso(until));
    expect(reservation.hosts['https://fast.example']!.lastRequestAt).toBe(iso(until));
    const calls = w.feedCalls().length;
    const r1 = await runCollection(srcs, on(), w.at(T0 + 30 * MIN), w.deps(store));
    expect(w.feedCalls().length).toBe(calls);
    if (r1.status === 'publish' || r1.status === 'kept-last-good') expect(r1.report?.notes.join(' ')).toMatch(/did not finish/);
    await runCollection(srcs, on(), w.at(T0 + 45 * MIN), w.deps(store));
    expect(w.feedCalls().length).toBe(calls + 1);
    expect(w.feedCalls().at(-1)!.at - until).toBeGreaterThanOrEqual(15 * MIN);
  });
});

describe('conditional requests, backoff and cool-downs', () => {
  it('sends the stored validators and shows the stored items when the feed answers 304', async () => {
    const w = world((url, o) => (o.etag === '"v1"' ? answer(url, 304) : steady(url) && ok(url, steady(url).body, { etag: '"v1"' })));
    const store = new MemoryStore();
    await runCollection([source('fast', 15)], on(), w.at(T0), w.deps(store));
    const r = await runCollection([source('fast', 15)], on(), w.at(T0 + 15 * MIN), w.deps(store));
    expect(w.feedCalls()[1]!.o.etag).toBe('"v1"');
    expect(r.status).toBe('publish');
    if (r.status !== 'publish') return;
    expect(r.health[0]).toMatchObject({ status: 'not-modified', ok: true });
    expect(r.traffic.notModified).toBe(1);
    expect(shown(r, 'fast')).toHaveLength(2);
  });

  it('backs off after a server error, keeping the items for a while', async () => {
    let failing = false;
    const w = world((url) => (failing && url.includes('fast') ? answer(url, 503) : steady(url)));
    const store = new MemoryStore();
    const srcs = [source('fast', 15), source('other', 15)];
    await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0), w.deps(store));
    failing = true;
    const r2 = await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0 + 15 * MIN), w.deps(store));
    expect(w.feedCalls('fast.example')).toHaveLength(3); // first attempt, then one retry
    expect(shown(r2, 'fast')).toHaveLength(2);
    failing = false;
    await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0 + 30 * MIN), w.deps(store));
    expect(w.feedCalls('fast.example')).toHaveLength(3); // backoff: twice the interval
    await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0 + 45 * MIN), w.deps(store));
    expect(w.feedCalls('fast.example')).toHaveLength(4);
  });

  it('stops showing a feed that answers 404', async () => {
    let gone = false;
    const w = world((url) => (gone && url.includes('fast') ? answer(url, 404) : steady(url)));
    const store = new MemoryStore();
    const srcs = [source('fast', 15), source('other', 15)];
    await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0), w.deps(store));
    gone = true;
    const r = await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0 + 15 * MIN), w.deps(store));
    expect(r.status).toBe('publish');
    expect(shown(r, 'fast')).toHaveLength(0);
  });

  it('leaves an origin alone for a day after HTTP 429, for every feed on it, and longer if Retry-After asks', async () => {
    for (const retryAfter of [undefined, String(48 * 3600)]) {
      const w = world((url) => (url.includes('/a.xml') ? answer(url, 429, { retryAfter }) : steady(url)));
      const store = new MemoryStore();
      const srcs = [source('a', 15, 'shared.example', '/a.xml'), source('b', 15, 'shared.example', '/b.xml'), source('c', 15)];
      const r1 = await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0), w.deps(store));
      expect(w.feedCalls('shared.example').map((x) => new URL(x.url).pathname)).toEqual(['/a.xml']);
      if (r1.status === 'publish') expect(r1.traffic.coolDownSkips).toBe(1);
      await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0 + 23 * 3600_000), w.deps(store));
      expect(w.feedCalls('shared.example')).toHaveLength(1);
      await runCollection(srcs, on({ minSourceShare: 0.1 }), w.at(T0 + 25 * 3600_000), w.deps(store));
      expect(w.feedCalls('shared.example').length, `Retry-After ${retryAfter}`).toBe(retryAfter ? 1 : 3);
    }
  });

  it('backs off an origin whose robots.txt gives no usable answer instead of asking on every run', async () => {
    const w = world(steady);
    const robotsFails = (url: string) => new URL(url).pathname === '/robots.txt';
    const fetcher: Fetcher = async (url, p, o) => {
      if (!robotsFails(url) || !url.includes('broken')) return w.deps().fetcher(url, p, o);
      w.calls.push({ url, at: w.c.t, o });
      return answer(url, 503);
    };
    const store = new MemoryStore();
    const srcs = [source('broken', 15), source('other', 15)];
    const d = () => ({ ...w.deps(store), fetcher });
    await runCollection(srcs, on({ minSourceShare: 0.1, retries: 0 }), w.at(T0), d());
    await runCollection(srcs, on({ minSourceShare: 0.1, retries: 0 }), w.at(T0 + 15 * MIN), d());
    expect(w.calls.filter((x) => x.url === 'https://broken.example/robots.txt')).toHaveLength(1);
    await runCollection(srcs, on({ minSourceShare: 0.1, retries: 0 }), w.at(T0 + 31 * MIN), d());
    expect(w.calls.filter((x) => x.url === 'https://broken.example/robots.txt')).toHaveLength(2);
    expect(w.feedCalls('broken.example')).toHaveLength(0);
  });

  it('keeps a Crawl-delay across runs from the saved time of the last request', async () => {
    const w = world(steady);
    const state = emptyState(new Date(T0));
    state.robots['https://slow.example'] = { fetchedAt: iso(T0 - 3600_000), policy: { kind: 'rules', status: 200, groups: [{ agents: ['*'], rules: [], crawlDelay: 20 }] } };
    state.hosts['https://slow.example'] = { lastRequestAt: iso(T0 - 5000) };
    const opts = { ...runOptionsFrom(on()), now: w.at(T0), mode: 'live' as const, nextUpdateAt: null, state, ...w.deps() };
    await collect([source('slow', 30)], opts);
    expect(w.c.sleeps).toEqual([15_000 + CRAWL_DELAY_MARGIN_MS]);
    expect(w.feedCalls()[0]!.at).toBe(T0 + 15_000 + CRAWL_DELAY_MARGIN_MS);
  });

  it('paces a redirect hop by the Crawl-delay of the origin it lands on', async () => {
    const w = world(steady, { 'slow.example': ['User-agent: *', 'Crawl-delay: 5'].join('\n') });
    const hops: number[] = [];
    const base = w.deps().fetcher;
    const fetcher: Fetcher = async (url, p, o) => {
      const first = await base(url, p, o);
      if (!url.endsWith('/feed.xml')) return first;
      // The feed answers with a redirect: the next hop must wait for the origin's Crawl-delay.
      const refused = await o.permitRedirect!(new URL('https://slow.example/moved.xml'));
      if (refused) return answer(url, 0, { error: refused });
      hops.push(w.c.t);
      return first;
    };
    const opts = { ...runOptionsFrom(on()), now: w.at(T0), mode: 'live' as const, nextUpdateAt: null, ...w.deps(), fetcher };
    await collect([source('slow', 30)], opts);
    const feedAt = w.feedCalls()[0]!.at;
    expect(hops).toHaveLength(1);
    expect(hops[0]! - feedAt).toBeGreaterThanOrEqual(5000);
  });

  it('re-reads an expired robots.txt only after the Crawl-delay it last asked for', async () => {
    const w = world(steady);
    const state = emptyState(new Date(T0));
    state.robots['https://slow.example'] = { fetchedAt: iso(T0 - 25 * 3600_000), policy: { kind: 'rules', status: 200, groups: [{ agents: ['*'], rules: [], crawlDelay: 120 }] } };
    state.hosts['https://slow.example'] = { lastRequestAt: iso(T0 - 30_000) };
    const opts = { ...runOptionsFrom(on()), now: w.at(T0), mode: 'live' as const, nextUpdateAt: null, state, ...w.deps() };
    const { health } = await collect([source('slow', 30)], opts);
    expect(w.calls).toHaveLength(0);
    expect(health[0]!.error).toMatch(/^skipped: robots\.txt not re-read yet/);
  });
});

describe('undated items', () => {
  const undated = (url: string) => ok(url, rssOf(new URL(url).host, [{ n: 1, date: null }, { n: 2, date: null }, { n: 3, date: T0 - 30 * MIN }]));

  it('keeps their first-seen time across runs, so an unchanged undated item does not look new again', async () => {
    const w = world(undated);
    const store = new MemoryStore();
    const srcs = [source('plain', 15)];
    await runCollection(srcs, on(), w.at(T0), w.deps(store));
    const r = await runCollection(srcs, on(), w.at(T0 + 15 * MIN), w.deps(store));
    expect(r.status).toBe('publish');
    if (r.status !== 'publish') return;
    const wire = JSON.parse(r.snapshotJson) as WireSnapshot;
    const plain = wire.articles.filter((a) => a.p === null);
    expect(plain).toHaveLength(2);
    expect(plain.map((a) => a.f)).toEqual([iso(T0), iso(T0)]);
    expect(r.report.feeds[0]).toMatchObject({ outcome: 'fetched', firstSeen: 0, undated: 2 });
    // What the browser sees: the same first-seen time, so the item ages instead of staying new.
    const snap = snapshotFromWire(wire);
    expect(snap.articles.filter((a) => a.publishedAt === null).map((a) => a.firstSeenAt)).toEqual([iso(T0), iso(T0)]);
    expect(snap.clusters.every((c) => Date.parse(c.firstSeen) <= T0)).toBe(true);
  });

  it('gives a new undated item the time it was first seen', async () => {
    let extra = false;
    const w = world((url) => ok(url, rssOf(new URL(url).host, [{ n: 1, date: null }, ...(extra ? [{ n: 9, date: null }] : [])])));
    const store = new MemoryStore();
    await runCollection([source('plain', 15)], on(), w.at(T0), w.deps(store));
    extra = true;
    const r = await runCollection([source('plain', 15)], on(), w.at(T0 + 15 * MIN), w.deps(store));
    if (r.status !== 'publish') throw new Error(r.status);
    expect(Object.fromEntries((JSON.parse(r.snapshotJson) as WireSnapshot).articles.map((a) => [a.u.slice(-1), a.f]))).toEqual({ 1: iso(T0), 9: iso(T0 + 15 * MIN) });
    expect(r.report.feeds[0]!.firstSeen).toBe(1);
  });

  it('does not believe a feed that re-dates its items on every request', async () => {
    const w = world((url, _o, t) => ok(url, rssOf(new URL(url).host, [{ n: 1, date: t }])));
    const store = new MemoryStore();
    const first = await runCollection([source('redate', 15)], on(), w.at(T0), w.deps(store));
    expect(shown(first, 'redate')[0]!.p).toBe(iso(T0));
    const r = await runCollection([source('redate', 15)], on(), w.at(T0 + 30 * MIN), w.deps(store));
    expect(shown(r, 'redate').map((a) => [a.p, a.f])).toEqual([[null, iso(T0)]]);
  });

  it('treats a future-dated item as undated and ages it from its first sighting', async () => {
    const w = world((url) => ok(url, rssOf(new URL(url).host, [{ n: 1, date: T0 + 5 * 3600_000 }])));
    const store = new MemoryStore();
    await runCollection([source('future', 15)], on(), w.at(T0), w.deps(store));
    const r = await runCollection([source('future', 15)], on(), w.at(T0 + 15 * MIN), w.deps(store));
    expect(shown(r, 'future')[0]).toMatchObject({ p: null, f: iso(T0) });
  });
});

describe('last known good', () => {
  it('leaves the published files untouched when a later run fails, is too soon, or is switched off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-site-'));
    const site = new DirSiteStore(dir, 3);
    let down = false;
    const w = world((url) => (down ? answer(url, 503) : steady(url)));
    const store = new MemoryStore();
    const srcs = [source('fast', 15), source('other', 15)];
    expect(await deliver(await runCollection(srcs, on(), w.at(T0), w.deps(store)), site, new Date(T0))).toBe(true);
    const before = readFileSync(join(dir, 'current', 'snapshot.json'), 'utf8');
    const rssBefore = readFileSync(join(dir, 'current', 'rss.xml'), 'utf8');
    down = true;
    const failed = await runCollection(srcs, on(), w.at(T0 + 15 * MIN), w.deps(store));
    expect(failed.status).toBe('kept-last-good');
    expect(await deliver(failed, site, new Date(T0 + 15 * MIN))).toBe(false);
    expect(await deliver(await runCollection(srcs, on(), w.at(T0 + 16 * MIN), w.deps(store)), site, new Date(T0 + 16 * MIN))).toBe(false);
    expect(await deliver(await runCollection(srcs, { ...on(), ingest: false }, w.at(T0 + 40 * MIN), w.deps(store)), site, new Date(T0 + 40 * MIN))).toBe(false);
    expect(readFileSync(join(dir, 'current', 'snapshot.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'current', 'rss.xml'), 'utf8')).toBe(rssBefore);
    expect(readdirSync(join(dir, 'history'))).toHaveLength(1);
  });

  it('keeps only the configured number of earlier versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-site-'));
    const site = new DirSiteStore(dir, 2);
    for (let i = 0; i < 4; i++) await site.publish([{ path: 'snapshot.json', body: String(i), contentType: 'application/json' }], `2026112${i}T000000Z`);
    expect(readdirSync(join(dir, 'history'))).toEqual(['20261122T000000Z', '20261123T000000Z']);
    expect(readFileSync(join(dir, 'current', 'snapshot.json'), 'utf8')).toBe('3');
    await expect(site.publish([{ path: '../escape.json', body: '', contentType: 'x' }], 's')).rejects.toThrow(/unsafe path/);
  });
});

describe('outgoing RSS checks before publishing', () => {
  it('refuses a malformed feed and a feed carrying a source that does not allow redistribution', async () => {
    const w = world(steady);
    const r = await runCollection(fixtureSources(), on(), w.at(T0), w.deps());
    if (r.status !== 'publish') throw new Error(r.status);
    const snap = snapshotFromWire(JSON.parse(r.snapshotJson) as WireSnapshot);
    expect(rssProblems(r.feeds, snap)).toEqual([]);
    const broken = r.feeds.map((d, i) => (i === 0 ? { ...d, xml: d.xml.replace('</channel>', '') } : d));
    expect(rssProblems(broken, snap)[0]).toMatch(/not well-formed/);
    const barred = snap.sources.find((s) => s.syndicate !== true)!;
    const leaked = snap.articles.find((a) => a.sourceId === barred.id)!;
    const victim = r.feeds.find((d) => d.items > 0)!;
    const tampered = r.feeds.map((d) => (d === victim ? { ...d, xml: d.xml.replace(/(<item>[\s\S]*?<link>)[^<]*(<\/link>)/, `$1${leaked.url}$2`) } : d));
    expect(rssProblems(tampered, snap).join(' ')).toMatch(/not from a source that allows redistribution/);
    expect(buildAllFeeds(snap, { feedUrlOf: () => undefined }).length).toBe(r.feeds.length);
  });
});

describe('a run whose feeds fail the RSS checks', () => {
  it('keeps the last good files instead of publishing them', async () => {
    const w = world(steady);
    const r = await runCollection(fixtureSources(), on(), w.at(T0), {
      ...w.deps(),
      buildFeeds: (snap, ctx) => buildAllFeeds(snap, ctx).map((d, i) => (i === 0 ? { ...d, xml: d.xml.replace('</channel>', '') } : d)),
    });
    expect(r.status).toBe('kept-last-good');
    expect(r.reasons.join(' ')).toMatch(/not well-formed/);
  });
});

describe('request ledger', () => {
  it('reports every request fetchFeed sends, redirect hops included', async () => {
    const events: RequestEvent[] = [];
    const responses = [new Response(null, { status: 301, headers: { location: '/moved.xml' } }), new Response('<rss/>', { status: 200 })];
    vi.stubGlobal('fetch', async () => responses.shift()!);
    try {
      const r = await fetchFeed('https://a.example/feed.xml', {
        allowHosts: new Set(['a.example']), userAgent: 'TheSignal/test', timeoutMs: 1000, maxBytes: 10_000,
        resolve: async () => [{ address: '93.184.215.14' }], observe: (e) => events.push(e),
      });
      expect(r.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(events.map((e) => [e.phase, e.hop, e.target, e.status])).toEqual([
      ['sent', 0, 'https://a.example/feed.xml', undefined], ['done', 0, 'https://a.example/feed.xml', 301],
      ['sent', 1, 'https://a.example/moved.xml', undefined], ['done', 1, 'https://a.example/moved.xml', 200],
    ]);
    expect(events.every((e) => e.userAgent === 'TheSignal/test')).toBe(true);
    expect(events.every((e) => e.url === 'https://a.example/feed.xml')).toBe(true);
  });
});
