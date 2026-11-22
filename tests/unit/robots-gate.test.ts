// Regression gate: robots.txt is read and evaluated before any request for publisher content,
// in the collector, in the validator and on every redirect hop. A feed that robots.txt disallows,
// or whose robots.txt is unreachable, is never requested.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SourceEntry } from '../../shared/types.ts';
import { collect, runOptionsFrom, type Fetcher } from '../../ingest/run.ts';
import { fetchFeed, type FetchOutcome, type FetchPolicy } from '../../ingest/fetch.ts';
import { createRobotsGate, CRAWL_DELAY_MARGIN_MS, robotsPolicyFrom, ROBOTS_MAX_AGE_MS, type RobotsCacheEntry } from '../../ingest/robots.ts';
import { DEFAULT_CONTROLS } from '../../ingest/controls.ts';
import { ROBOTS_TOKEN } from '../../shared/identity.ts';
import { checkFeed } from '../../tools/validate-sources.ts';
import { fixtureSources } from '../fixtures/news-day.ts';

const NOW = new Date('2026-11-22T12:00:00Z');
const UA = 'TheSignal/test';

function ok(url: string, body: string): FetchOutcome {
  return { url, finalUrl: url, status: 200, ok: true, notModified: false, body, bytes: body.length, ms: 1 };
}
function fail(url: string, status: number, error = `HTTP ${status}`): FetchOutcome {
  return { url, finalUrl: url, status, ok: false, notModified: false, body: '', bytes: 0, ms: 1, error };
}
function feed(host: string): string {
  const items = [0, 1, 2].map((i) => `<item><title>${host} item ${i} about subject${i}</title><link>https://${host}/news/${i}</link><pubDate>Sun, 22 Nov 2026 10:0${i}:00 GMT</pubDate></item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${host}</title><link>https://${host}/</link>${items}</channel></rss>`;
}

/** A fake network that records every URL in request order. robots.txt answers come from `robots`. */
function net(robots: (host: string) => FetchOutcome | string) {
  const order: string[] = [];
  const fetcher: Fetcher = async (url) => {
    order.push(url);
    const u = new URL(url);
    if (u.pathname === '/robots.txt') {
      const a = robots(u.hostname);
      return typeof a === 'string' ? ok(url, a) : a;
    }
    return ok(url, feed(u.hostname));
  };
  return { fetcher, order, feedRequests: () => order.filter((x) => !x.endsWith('/robots.txt')) };
}

/** n fixture sources, each with one feed on its own host (or on the hosts given). */
function sources(hosts: string[], path = '/rss.xml'): SourceEntry[] {
  const base = fixtureSources();
  return hosts.map((h, i) => ({ ...base[i]!, id: `src${i}`, feeds: [{ ...base[i]!.feeds[0]!, url: `https://${h}${path}` }] }));
}

const opts = { ...runOptionsFrom({ ...DEFAULT_CONTROLS, ingest: true, retryDelayMs: 0, retries: 0 }), now: NOW, mode: 'live' as const, nextUpdateAt: null };

describe('robots.txt before publisher content (collector)', () => {
  it('requests robots.txt for an origin before any feed on it', async () => {
    const n = net(() => 'User-agent: *\nAllow: /');
    const srcs = sources(['a.example', 'b.example', 'c.example']);
    const { health } = await collect(srcs, { ...opts, fetcher: n.fetcher });
    expect(n.feedRequests().length).toBe(3);
    for (const f of n.feedRequests()) {
      const robotsAt = n.order.indexOf(new URL(f).origin + '/robots.txt');
      expect(robotsAt, f).toBeGreaterThanOrEqual(0);
      expect(robotsAt, f).toBeLessThan(n.order.indexOf(f));
    }
    expect(health.every((h) => h.ok)).toBe(true);
  });

  it('never requests a feed that robots.txt disallows for The Signal, and says why', async () => {
    const n = net((h) => (h === 'b.example' ? `User-agent: ${ROBOTS_TOKEN}\nDisallow: /rss\n\nUser-agent: *\nAllow: /` : ''));
    const srcs = sources(['a.example', 'b.example']);
    const { health, traffic } = await collect(srcs, { ...opts, fetcher: n.fetcher });
    expect(n.feedRequests()).toEqual(['https://a.example/rss.xml']);
    expect(health.find((h) => h.sourceId === 'src1')!.error).toBe('robots.txt disallows /rss.xml (Disallow: /rss)');
    expect(traffic).toEqual({ feedRequests: 1, robotsRequests: 2, robotsRefusals: 1, crawlDelayDeferrals: 0, notDue: 0, notModified: 0, coolDownSkips: 0, bytes: traffic.bytes });
  });

  it('treats an unreachable robots.txt as disallow-all, and a missing one (4xx) as no restrictions', async () => {
    const answers: Record<string, FetchOutcome | string> = {
      'down.example': fail('x', 503),
      'limited.example': fail('x', 429),
      'hn.example': fail('x', 419),
      'offline.example': fail('x', 0, 'timeout'),
      'missing.example': fail('x', 404),
      'denied.example': fail('x', 403),
    };
    const n = net((h) => answers[h]!);
    const srcs = sources(Object.keys(answers));
    const { health } = await collect(srcs, { ...opts, fetcher: n.fetcher });
    expect(n.feedRequests().map((u) => new URL(u).hostname).sort()).toEqual(['denied.example', 'missing.example']);
    const err = (i: number) => health.find((h) => h.sourceId === `src${i}`)!.error;
    expect(err(0)).toBe('robots.txt unreachable (HTTP 503); treated as disallow-all (RFC 9309 2.3.1.4)');
    expect(err(3)).toBe('robots.txt unreachable (timeout); treated as disallow-all (RFC 9309 2.3.1.4)');
  });

  it('asks each origin for robots.txt once per run, however many feeds it serves', async () => {
    const n = net(() => '');
    const srcs = sources(['same.example', 'same.example', 'same.example', 'other.example']).map((s, i) => ({ ...s, feeds: [{ ...s.feeds[0]!, url: s.feeds[0]!.url + `?f=${i}` }] }));
    await collect(srcs, { ...opts, fetcher: n.fetcher });
    expect(n.order.filter((u) => u.endsWith('/robots.txt')).sort()).toEqual(['https://other.example/robots.txt', 'https://same.example/robots.txt']);
    expect(n.feedRequests().length).toBe(4);
  });

  it('reuses a kept robots.txt answer for under 24 hours and asks again after that', async () => {
    const srcs = sources(['kept.example']);
    const entry = (ageMs: number): RobotsCacheEntry => ({
      fetchedAt: new Date(NOW.getTime() - ageMs).toISOString(),
      policy: { kind: 'rules', status: 200, groups: [{ agents: ['*'], rules: [{ allow: false, pattern: '/' }] }] },
    });
    const fresh = net(() => 'User-agent: *\nAllow: /');
    await collect(srcs, { ...opts, fetcher: fresh.fetcher, robotsCache: new Map([['https://kept.example', entry(ROBOTS_MAX_AGE_MS - 60_000)]]) });
    expect(fresh.order).toEqual([]); // the kept answer (disallow everything) applies; nothing is requested

    const cache = new Map([['https://kept.example', entry(ROBOTS_MAX_AGE_MS + 60_000)]]);
    const stale = net(() => 'User-agent: *\nAllow: /');
    await collect(srcs, { ...opts, fetcher: stale.fetcher, robotsCache: cache });
    expect(stale.order).toEqual(['https://kept.example/robots.txt', 'https://kept.example/rss.xml']);
    expect(cache.get('https://kept.example')!.fetchedAt).toBe(NOW.toISOString());
  });

  it('never keeps an unreachable answer between runs', async () => {
    const cache = new Map<string, RobotsCacheEntry>();
    await collect(sources(['down.example']), { ...opts, fetcher: net(() => fail('x', 503)).fetcher, robotsCache: cache });
    expect(cache.size).toBe(0);
  });

  it('checks robots.txt on the redirect target before the collector follows a redirect', async () => {
    const order: string[] = [];
    let permitAnswer: string | null | undefined;
    const fetcher: Fetcher = async (url, _p, o) => {
      order.push(url);
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return ok(url, u.hostname === 'moved.example' ? 'User-agent: *\nDisallow: /private' : '');
      permitAnswer = await o.permitRedirect!(new URL('https://moved.example/private/feed'));
      return fail(url, 0, permitAnswer ?? 'followed');
    };
    await collect(sources(['start.example']), { ...opts, fetcher });
    expect(permitAnswer).toBe('robots.txt disallows /private/feed (Disallow: /private)');
    expect(order).toEqual(['https://start.example/robots.txt', 'https://start.example/rss.xml', 'https://moved.example/robots.txt']);
  });
});

describe('robots.txt Crawl-delay', () => {
  /** A fake clock: sleeping advances it, and every request is stamped with the time it was made. */
  function timedNet(robotsTxt: string) {
    let t = 0;
    const at: [string, number][] = [];
    const fetcher: Fetcher = async (url) => {
      at.push([url, t]);
      return new URL(url).pathname === '/robots.txt' ? ok(url, robotsTxt) : ok(url, feed(new URL(url).hostname));
    };
    return { fetcher, at, clock: () => t, sleep: async (ms: number) => { t += ms; } };
  }

  it('spaces every request to a host, robots.txt included, by its Crawl-delay', async () => {
    const n = timedNet('User-agent: *\nCrawl-delay: 5\nAllow: /');
    const srcs = sources(['slow.example', 'slow.example']).map((s, i) => ({ ...s, feeds: [{ ...s.feeds[0]!, url: `https://slow.example/f${i}.xml` }] }));
    const { health } = await collect(srcs, { ...opts, concurrency: 1, fetcher: n.fetcher, clock: n.clock, sleep: n.sleep });
    expect(n.at.map(([u]) => new URL(u).pathname)).toEqual(['/robots.txt', '/f0.xml', '/f1.xml']);
    const gap = 5000 + CRAWL_DELAY_MARGIN_MS;
    expect(n.at.map(([, t]) => t)).toEqual([0, gap, 2 * gap]);
    expect(health.every((h) => h.ok)).toBe(true);
  });

  it('counts the Crawl-delay from the end of a slow robots.txt answer, not from when it was asked', async () => {
    let t = 0;
    const at: [string, number][] = [];
    const fetcher: Fetcher = async (url) => {
      at.push([url, t]);
      if (new URL(url).pathname === '/robots.txt') { t += 4000; return ok(url, ['User-agent: *', 'Crawl-delay: 5'].join('\n')); }
      return ok(url, feed(new URL(url).hostname));
    };
    const srcs = sources(['slow.example']);
    await collect(srcs, { ...opts, concurrency: 1, fetcher, clock: () => t, sleep: async (ms: number) => { t += ms; } });
    const feedAt = at.find(([u]) => !u.endsWith('/robots.txt'))![1];
    expect(feedAt).toBe(4000 + 5000 + CRAWL_DELAY_MARGIN_MS);
  });

  it('gives requests that start together separate slots, one Crawl-delay apart', async () => {
    const policy: FetchPolicy = { allowHosts: new Set(['slow.example']), userAgent: UA, timeoutMs: 1000, maxBytes: 1 << 20 };
    const waits: number[] = [];
    const gate = createRobotsGate(async (url) => ok(url, 'User-agent: *\nCrawl-delay: 5'), policy, {
      now: NOW, token: ROBOTS_TOKEN, clock: () => 0, sleep: async (ms) => { waits.push(ms); },
    });
    await gate.check('https://slow.example/a', UA);
    expect(await Promise.all([gate.pace('https://slow.example/a', UA), gate.pace('https://slow.example/b', UA)])).toEqual([null, null]);
    expect(waits).toEqual([5000 + CRAWL_DELAY_MARGIN_MS, 2 * (5000 + CRAWL_DELAY_MARGIN_MS)]);
  });

  it('defers a feed whose Crawl-delay is longer than a run may wait, then fetches it next run from the kept robots.txt', async () => {
    const cache = new Map<string, RobotsCacheEntry>();
    const first = timedNet('User-agent: *\nCrawl-delay: 420');
    const run1 = await collect(sources(['gao.example']), { ...opts, fetcher: first.fetcher, clock: first.clock, sleep: first.sleep, robotsCache: cache });
    expect(first.at.map(([u]) => u)).toEqual(['https://gao.example/robots.txt']);
    expect(run1.health[0]!.status).toBe('skipped');
    expect(run1.health[0]!.error).toBe('skipped: robots.txt Crawl-delay is 420 s; deferred to a later run');
    expect(run1.traffic.crawlDelayDeferrals).toBe(1);

    const second = timedNet('User-agent: *\nCrawl-delay: 420');
    const run2 = await collect(sources(['gao.example']), { ...opts, fetcher: second.fetcher, clock: second.clock, sleep: second.sleep, robotsCache: cache });
    expect(second.at).toEqual([['https://gao.example/rss.xml', 0]]);
    expect(run2.health[0]!.ok).toBe(true);
  });
});

describe('robots.txt answers (RFC 9309 2.3.1)', () => {
  it('maps each kind of answer to rules, no restrictions or complete disallow', () => {
    expect(robotsPolicyFrom(ok('x', 'User-agent: *\nDisallow: /')).kind).toBe('rules');
    for (const s of [400, 401, 403, 404, 410]) expect(robotsPolicyFrom(fail('x', s)).kind, String(s)).toBe('none');
    for (const s of [419, 429, 500, 503, 0]) expect(robotsPolicyFrom(fail('x', s)).kind, String(s)).toBe('unreachable');
  });

  it('retries a failed robots.txt request only for network and server errors, within the attempts given', async () => {
    let calls = 0;
    const policy: FetchPolicy = { allowHosts: new Set(['x.example']), userAgent: UA, timeoutMs: 1000, maxBytes: 1 << 20 };
    const gate = createRobotsGate(async (url) => { calls++; return fail(url, 503); }, policy, { now: NOW, token: ROBOTS_TOKEN, attempts: 2 });
    expect((await gate.check('https://x.example/feed', UA)).allowed).toBe(false);
    expect(calls).toBe(2);
    calls = 0;
    const gate404 = createRobotsGate(async (url) => { calls++; return fail(url, 404); }, policy, { now: NOW, token: ROBOTS_TOKEN, attempts: 2 });
    expect((await gate404.check('https://x.example/feed', UA)).allowed).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('robots.txt on redirect hops (fetchFeed)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const policy: FetchPolicy = {
    allowHosts: new Set(['a.example', 'b.example']), userAgent: UA, timeoutMs: 5000, maxBytes: 1 << 20,
    resolve: async () => [{ address: '93.184.215.14' }],
  };

  function stubNetwork() {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (u: URL | string) => {
      const url = String(u);
      requested.push(url);
      if (url.startsWith('https://a.example/')) return new Response(null, { status: 301, headers: { location: 'https://b.example/feed.xml' } });
      return new Response(feed('b.example'), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    });
    return requested;
  }

  it('asks before following a redirect and requests nothing from the new location when refused', async () => {
    const requested = stubNetwork();
    const asked: string[] = [];
    const r = await fetchFeed('https://a.example/rss', policy, { permitRedirect: async (next) => { asked.push(next.toString()); return 'robots.txt disallows /feed.xml (Disallow: /)'; } });
    expect(asked).toEqual(['https://b.example/feed.xml']);
    expect(requested).toEqual(['https://a.example/rss']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('robots.txt disallows /feed.xml (Disallow: /)');
  });

  it('follows the redirect when the new location is allowed', async () => {
    const requested = stubNetwork();
    const r = await fetchFeed('https://a.example/rss', policy, { permitRedirect: async () => null });
    expect(requested).toEqual(['https://a.example/rss', 'https://b.example/feed.xml']);
    expect(r.ok).toBe(true);
  });
});

describe('robots.txt before publisher content (validator)', () => {
  const policy: FetchPolicy = { allowHosts: new Set(['v.example']), userAgent: UA, timeoutMs: 1000, maxBytes: 1 << 20 };
  const cand = { id: 'v', name: 'V', homepage: 'https://v.example/', section: 'world' as const, country: 'GB', feeds: [] };
  const f = { url: 'https://v.example/rss.xml', kind: 'rss' as const, subsection: 'world-general' as const };

  it('never requests a feed that robots.txt disallows and reports it as disallowed', async () => {
    const n = net(() => 'User-agent: *\nDisallow: /rss');
    const robots = createRobotsGate(n.fetcher, policy, { now: NOW, token: ROBOTS_TOKEN });
    const r = await checkFeed(cand, f, NOW, { fetcher: n.fetcher, policy, robots });
    expect(n.order).toEqual(['https://v.example/robots.txt']);
    expect(r.verdict).toBe('disallowed');
    expect(r.robots).toBe(false);
    expect(r.robotsRule).toBe('Disallow: /rss');
  });

  it('does not follow a redirect to a location robots.txt disallows', async () => {
    const order: string[] = [];
    const fetcher: Fetcher = async (url, _p, o) => {
      order.push(url);
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return ok(url, u.hostname === 'w.example' ? 'User-agent: *\nDisallow: /' : '');
      if (u.hostname === 'v.example') {
        const next = new URL('https://w.example/feed.xml');
        const refused = await o.permitRedirect!(next);
        if (refused) return { ...fail(url, 0, refused), finalUrl: next.toString() };
        return fetcher(next.toString(), _p, o);
      }
      return ok(url, feed(u.hostname));
    };
    const robots = createRobotsGate(fetcher, policy, { now: NOW, token: ROBOTS_TOKEN });
    const r = await checkFeed(cand, f, NOW, { fetcher, policy, robots });
    expect(order).toEqual(['https://v.example/robots.txt', 'https://v.example/rss.xml', 'https://w.example/robots.txt']);
    expect(r.verdict).toBe('disallowed');
    expect(r.robotsRule).toBe('Disallow: /');
  });

  it('reads robots.txt first and then validates an allowed feed', async () => {
    const n = net(() => 'User-agent: *\nAllow: /');
    const robots = createRobotsGate(n.fetcher, policy, { now: NOW, token: ROBOTS_TOKEN });
    const r = await checkFeed(cand, f, NOW, { fetcher: n.fetcher, policy, robots });
    expect(n.order).toEqual(['https://v.example/robots.txt', 'https://v.example/rss.xml']);
    expect(r.verdict).toBe('ok');
    expect(r.robots).toBe(true);
  });
});

describe('no path to publisher content around the gate', () => {
  // tools/mutate.mjs is left out: it quotes source lines as mutation patterns and makes no requests.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'ingest', 'tools', 'src', 'shared', 'api'], { encoding: 'utf8' })
    .split('\n').filter((x) => /\.(ts|tsx|mjs)$/.test(x) && x !== 'tools/mutate.mjs');
  /** Source text without comments, so prose that mentions fetching does not count as a call. */
  const code = (x: string) => readFileSync(x, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it('lets only ingest/fetch.ts call the network directly', () => {
    const direct = files.filter((x) => !['ingest/fetch.ts', 'src/lib/data.ts', 'tools/smoke-prod.ts'].includes(x) && /(?<![.\w])fetch\s*\(/.test(code(x)));
    expect(direct).toEqual([]);
    // The page reads only its own snapshot, never a publisher.
    expect(code('src/lib/data.ts').match(/(?<![.\w])fetch\s*\(([^,)]*)/g)).toEqual(["fetch('data/snapshot.json'"]);
    // The post-deploy checks request only the site under test: one call, behind an origin guard.
    expect(code('tools/smoke-prod.ts').match(/(?<![.\w])fetch\s*\(([^,)]*)/g)).toEqual(['fetch(u']);
    expect(code('tools/smoke-prod.ts')).toMatch(/if \(!allowed\.has\(new URL\(u\)\.origin\)\) throw/);
  });

  it('creates a robots.txt gate in every module that requests feeds', () => {
    const users = files.filter((x) => x !== 'ingest/fetch.ts' && /\bfetchFeed\b/.test(code(x)));
    expect(users.sort()).toEqual(['ingest/run.ts', 'tools/validate-sources.ts']);
    for (const x of users) expect(code(x), x).toMatch(/createRobotsGate\(/);
  });
});
