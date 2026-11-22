import { describe, expect, it } from 'vitest';
import type { SourceEntry } from '../../shared/types.ts';
import { DEFAULT_CONTROLS, LIMITS, readControls, type Controls } from '../../ingest/controls.ts';
import { runCollection } from '../../ingest/publish.ts';
import { collect, excludedPath, retryable, runOptionsFrom, type Fetcher } from '../../ingest/run.ts';
import type { FetchOutcome } from '../../ingest/fetch.ts';
import { fixtureSources } from '../fixtures/news-day.ts';

const NOW = new Date('2026-11-22T12:00:00Z');

function rss(host: string, n: number, extra = ''): string {
  const items = Array.from({ length: n }, (_, i) =>
    `<item><title>${host} story number ${i} about topic${host.length}${i}</title><link>https://${host}/news/${i}</link><pubDate>Sun, 22 Nov 2026 1${i % 10}:00:00 GMT</pubDate>${extra}</item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${host}</title><link>https://${host}/</link>${items}</channel></rss>`;
}

function ok(url: string, body: string): FetchOutcome {
  return { url, finalUrl: url, status: 200, ok: true, notModified: false, body, bytes: body.length, ms: 1 };
}
function fail(url: string, status: number, error: string): FetchOutcome {
  return { url, finalUrl: url, status, ok: false, notModified: false, body: '', bytes: 0, ms: 1, error };
}

/**
 * A fake network: counts calls per feed URL and answers with a small valid feed. robots.txt
 * requests are answered separately (404, meaning no robots.txt, unless a test says otherwise)
 * and are not counted as feed calls.
 */
function fakeNet(answer?: (url: string, call: number) => FetchOutcome) {
  const calls = new Map<string, number>();
  let robotsCalls = 0;
  const fetcher: Fetcher = async (url) => {
    if (new URL(url).pathname === '/robots.txt') { robotsCalls++; return fail(url, 404, 'HTTP 404'); }
    const n = (calls.get(url) ?? 0) + 1;
    calls.set(url, n);
    return answer ? answer(url, n) : ok(url, rss(new URL(url).hostname, 8));
  };
  return { fetcher, calls, total: () => [...calls.values()].reduce((a, b) => a + b, 0), robotsCalls: () => robotsCalls };
}

const on = (over: Partial<Controls> = {}): Controls => ({ ...DEFAULT_CONTROLS, ingest: true, retryDelayMs: 0, minArticles: 10, ...over });

describe('reading controls from the environment', () => {
  it('keeps ingestion off unless SIGNAL_INGEST is exactly on', () => {
    expect(readControls({}).controls.ingest).toBe(false);
    expect(readControls({ SIGNAL_INGEST: 'on' }).controls.ingest).toBe(true);
    const typo = readControls({ SIGNAL_INGEST: 'yes please' });
    expect(typo.controls.ingest).toBe(false);
    expect(typo.warnings[0]).toMatch(/not on\/off/);
    expect(readControls({ SIGNAL_INGEST: 'off' }).controls.ingest).toBe(false);
  });

  it('turns RSS output off with SIGNAL_RSS=off and leaves it on by default', () => {
    expect(readControls({}).controls.rss).toBe(true);
    expect(readControls({ SIGNAL_RSS: 'off' }).controls.rss).toBe(false);
  });

  it('clamps every numeric setting to its floor and ceiling', () => {
    for (const [key, [name, lo, hi]] of Object.entries(LIMITS)) {
      const high = readControls({ [name]: String(hi * 10 + 1) });
      expect(high.controls[key as keyof Controls], name).toBe(hi);
      expect(high.warnings.length, name).toBe(1);
      const low = readControls({ [name]: String(-1) });
      expect(low.controls[key as keyof Controls], name).toBe(lo);
    }
  });

  it('ignores a value that is not a number and keeps the default', () => {
    const r = readControls({ SIGNAL_MAX_FEEDS: 'lots' });
    expect(r.controls.maxFeedsPerRun).toBe(DEFAULT_CONTROLS.maxFeedsPerRun);
    expect(r.warnings[0]).toMatch(/not a number/);
  });

  it('keeps every default inside its own limits', () => {
    for (const [key, [, lo, hi]] of Object.entries(LIMITS)) {
      const v = DEFAULT_CONTROLS[key as keyof Controls] as number;
      expect(v >= lo && v <= hi, key).toBe(true);
    }
  });
});

describe('a scheduled run', () => {
  it('fetches nothing and publishes nothing while ingestion is switched off', async () => {
    const net = fakeNet();
    const r = await runCollection(fixtureSources(), { ...DEFAULT_CONTROLS }, NOW, { fetcher: net.fetcher });
    expect(r.status).toBe('suspended');
    expect(net.total()).toBe(0);
    expect(net.robotsCalls()).toBe(0);
  });

  it('publishes a snapshot and feeds when enough sources answer', async () => {
    const net = fakeNet();
    const r = await runCollection(fixtureSources(), on(), NOW, { fetcher: net.fetcher });
    expect(r.status).toBe('publish');
    if (r.status !== 'publish') return;
    expect(JSON.parse(r.snapshotJson).mode).toBe('live');
    expect(r.feeds.length).toBe(9);
  });

  it('writes no feeds when RSS output is switched off', async () => {
    const r = await runCollection(fixtureSources(), on({ rss: false }), NOW, { fetcher: fakeNet().fetcher });
    expect(r.status).toBe('publish');
    if (r.status === 'publish') expect(r.feeds).toEqual([]);
  });

  it('keeps the last good snapshot when too few sources answer', async () => {
    const net = fakeNet((url, _n) => (url.includes('thames') || url.includes('capitol') ? ok(url, rss(new URL(url).hostname, 8)) : fail(url, 503, 'HTTP 503')));
    const r = await runCollection(fixtureSources(), on({ retries: 0 }), NOW, { fetcher: net.fetcher });
    expect(r.status).toBe('kept-last-good');
    expect(r.reasons.join(' ')).toMatch(/sources answered/);
  });

  it('keeps the last good snapshot when it would be larger than the limit', async () => {
    const r = await runCollection(fixtureSources(), on({ maxSnapshotBytes: 1000 }), NOW, { fetcher: fakeNet().fetcher });
    expect(r.status).toBe('kept-last-good');
    expect(r.reasons.join(' ')).toMatch(/over the 1000 byte limit/);
  });

  it('does not collect sources that are disabled, gated or not READY', async () => {
    const srcs = fixtureSources();
    srcs[0]!.enabled = false;
    srcs[1]!.gates = ['recheck'];
    srcs[2]!.status = 'CONDITIONAL';
    const net = fakeNet();
    await runCollection(srcs, on({ minSourceShare: 0.1 }), NOW, { fetcher: net.fetcher });
    for (const s of srcs.slice(0, 3)) expect(net.calls.has(s.feeds[0]!.url), s.id).toBe(false);
    expect(net.calls.has(srcs[3]!.feeds[0]!.url)).toBe(true);
  });
});

describe('collection limits', () => {
  const opts = (over: Partial<Controls> = {}) => ({ ...runOptionsFrom(on(over)), now: NOW, mode: 'live' as const, nextUpdateAt: null });

  it('attempts at most maxFeedsPerRun feeds and reports the rest as skipped', async () => {
    const net = fakeNet();
    const { health } = await collect(fixtureSources(), { ...opts({ maxFeedsPerRun: 5 }), fetcher: net.fetcher });
    expect(net.total()).toBe(5);
    expect(health.filter((h) => h.status === 'skipped').length).toBe(fixtureSources().length - 5);
  });

  it('stops starting fetches once the run byte budget is spent', async () => {
    const big = 'x'.repeat(4096);
    const net = fakeNet((url) => ok(url, rss(new URL(url).hostname, 3, `<description>${big}</description>`)));
    const { health } = await collect(fixtureSources(), { ...opts({ concurrency: 1 }), maxBytesPerRun: 20_000, fetcher: net.fetcher });
    expect(net.total()).toBeLessThan(fixtureSources().length);
    expect(health.some((h) => h.error === 'skipped: run byte budget spent')).toBe(true);
  });

  it('retries a server error exactly as many times as configured, and never a 4xx', async () => {
    for (const retries of [0, 1, 2]) {
      const net = fakeNet((url) => fail(url, 503, 'HTTP 503'));
      await collect(fixtureSources().slice(0, 1), { ...opts({ retries }), fetcher: net.fetcher });
      expect(net.total(), `retries=${retries}`).toBe(1 + retries);
    }
    const net404 = fakeNet((url) => fail(url, 404, 'HTTP 404'));
    await collect(fixtureSources().slice(0, 1), { ...opts({ retries: 2 }), fetcher: net404.fetcher });
    expect(net404.total()).toBe(1);
  });

  it('does not retry policy refusals such as an off-allowlist redirect', () => {
    expect(retryable(fail('https://a.example/', 0, 'host not on allowlist: evil.example'))).toBe(false);
    expect(retryable(fail('https://a.example/', 0, 'timeout'))).toBe(true);
    expect(retryable(fail('https://a.example/', 502, 'HTTP 502'))).toBe(true);
  });

  it('leaves out items credited to a wire service the source must not show', async () => {
    const srcs = fixtureSources().slice(0, 1);
    srcs[0]!.filters = { dropWires: ['AP'] };
    const net = fakeNet((url) => ok(url, rss(new URL(url).hostname, 4, '<dc:creator>Associated Press</dc:creator>')));
    const { snapshot } = await collect(srcs, { ...opts(), fetcher: net.fetcher });
    expect(snapshot.articles).toHaveLength(0);
  });

  it('leaves out items under an excluded path and keeps the rest', async () => {
    expect(excludedPath('https://x.example/newswire/2026/a', ['/newswire/'])).toBe(true);
    expect(excludedPath('https://x.example/news/2026/a', ['/newswire/'])).toBe(false);
    expect(excludedPath('not a url', ['/newswire/'])).toBe(true);
    const srcs = fixtureSources().slice(0, 1);
    srcs[0]!.filters = { excludePaths: ['/news/1', '/news/2'] };
    const { snapshot } = await collect(srcs, { ...opts(), fetcher: fakeNet().fetcher });
    expect(snapshot.articles.map((a) => new URL(a.url).pathname).sort()).toEqual(['/news/0', '/news/3', '/news/4', '/news/5', '/news/6', '/news/7']);
  });
});
