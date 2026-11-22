import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchOutcome } from '../../ingest/fetch.ts';
import type { Fetcher } from '../../ingest/run.ts';
import { fixtureSources } from '../fixtures/news-day.ts';
import { buildAllFeeds } from '../../shared/rss.ts';

// An in-memory Vercel Blob: two stores chosen by token, ETags, conditional writes as the SDK
// documents them (ifMatch, allowOverwrite: false).
const blob = vi.hoisted(() => {
  const stores = { pub: new Map<string, { body: string; etag: string; opts: Record<string, unknown> }>(), priv: new Map<string, { body: string; etag: string; opts: Record<string, unknown> }>() };
  let n = 0;
  class BlobPreconditionFailedError extends Error {}
  const pick = (o: { token?: string } | undefined) => (o?.token === 'pub' ? stores.pub : stores.priv);
  return { stores, BlobPreconditionFailedError, pick, next: () => `"e${++n}"`, reset: () => { stores.pub.clear(); stores.priv.clear(); } };
});
vi.mock('@vercel/blob', () => ({
  BlobPreconditionFailedError: blob.BlobPreconditionFailedError,
  put: async (path: string, body: string, o: Record<string, unknown> & { token?: string; ifMatch?: string; allowOverwrite?: boolean }) => {
    const m = blob.pick(o);
    const cur = m.get(path);
    if (o.ifMatch !== undefined && cur?.etag !== o.ifMatch) throw new blob.BlobPreconditionFailedError();
    if (o.ifMatch === undefined && !o.allowOverwrite && cur) throw new Error('Vercel Blob: This blob already exists');
    const etag = blob.next();
    m.set(path, { body: String(body), etag, opts: o });
    return { url: `https://store.example/${path}`, pathname: path, etag };
  },
  get: async (path: string, o: { token?: string }) => {
    const cur = blob.pick(o).get(path);
    if (!cur) return null;
    return { statusCode: 200, stream: new Response(cur.body).body, headers: new Headers(), blob: { etag: cur.etag, url: '', pathname: path } };
  },
  list: async (o: { token?: string; prefix: string }) => ({ blobs: [...blob.pick(o).keys()].filter((k) => k.startsWith(o.prefix)).map((pathname) => ({ pathname })), hasMore: false }),
  del: async (paths: string | string[], o: { token?: string }) => { for (const p of ([] as string[]).concat(paths)) blob.pick(o).delete(p); },
}));

const { productionRun } = await import('../../ingest/production.ts');
const { BlobSiteStore, pruneOpsLogs } = await import('../../ingest/blob.ts');
const { rollback, summarize } = await import('../../tools/ops.ts');
const { GET } = await import('../../api/collect.ts');

const T0 = Date.parse('2026-11-22T12:00:00Z');
const ENV = {
  SIGNAL_INGEST: 'on', SIGNAL_DEPLOYMENT: 'production', VERCEL_ENV: 'production', SIGNAL_MIN_ARTICLES: '1', SIGNAL_RETRY_DELAY_MS: '0',
  PUBLIC_BLOB_READ_WRITE_TOKEN: 'pub', PRIVATE_BLOB_READ_WRITE_TOKEN: 'priv',
};

function net() {
  let feeds = 0;
  const fetcher: Fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { url, finalUrl: url, status: 404, ok: false, notModified: false, body: '', bytes: 0, ms: 1, error: 'HTTP 404' };
    feeds++;
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://${u.host}/</link>`
      + [1, 2, 3].map((i) => `<item><title>Report ${i} from ${u.host} on the harbor works</title><link>https://${u.host}/news/${i}</link><pubDate>${new Date(T0 - i * 3600_000).toUTCString()}</pubDate></item>`).join('')
      + '</channel></rss>';
    return { url, finalUrl: url, status: 200, ok: true, notModified: false, body, bytes: body.length, ms: 1 } satisfies FetchOutcome;
  };
  return { fetcher, feeds: () => feeds };
}
const deps = (n: ReturnType<typeof net>, t: number) => ({ fetcher: n.fetcher, now: new Date(t), clock: () => t, sleep: async () => {} });
const setPriv = (path: string, value: unknown) => blob.stores.priv.set(path, { body: JSON.stringify(value), etag: blob.next(), opts: {} });
const ready = () => {
  setPriv('identity.json', { deployment: 'production', project: 'the-signal' });
  setPriv('control.json', { collect: 'on' });
};

beforeEach(() => blob.reset());

describe('a production run', () => {
  it('stops before any request when control.json is missing: deleting it is the kill switch', async () => {
    setPriv('identity.json', { deployment: 'production', project: 'the-signal' });
    const n = net();
    const r = await productionRun(ENV, fixtureSources(), deps(n, T0));
    expect(r.status).toBe('stopped');
    expect(n.feeds()).toBe(0);
    expect([...blob.stores.priv.keys()].some((k) => k.startsWith('ops/'))).toBe(true);
    expect(blob.stores.pub.size).toBe(0);
  });

  it('stops for a control file that does not say collect on', async () => {
    setPriv('identity.json', { deployment: 'production', project: 'the-signal' });
    setPriv('control.json', { collect: 'off' });
    const n = net();
    expect((await productionRun(ENV, fixtureSources(), deps(n, T0))).status).toBe('stopped');
    expect(n.feeds()).toBe(0);
  });

  it('refuses a private store that belongs to another project or deployment', async () => {
    setPriv('identity.json', { deployment: 'preview', project: 'the-signal' });
    setPriv('control.json', { collect: 'on' });
    const n = net();
    const r = await productionRun(ENV, fixtureSources(), deps(n, T0));
    expect(r).toMatchObject({ status: 'refused' });
    expect(n.feeds()).toBe(0);
  });

  it('does nothing unless SIGNAL_INGEST is on and this is the production deployment', async () => {
    ready();
    const n = net();
    expect((await productionRun({ ...ENV, SIGNAL_INGEST: 'off' }, fixtureSources(), deps(n, T0))).status).toBe('suspended');
    expect((await productionRun({ ...ENV, VERCEL_ENV: 'preview' }, fixtureSources(), deps(n, T0))).status).toBe('refused');
    expect(n.feeds()).toBe(0);
  });

  it('publishes the snapshot and feeds to the public store, with cache lifetimes, and keeps the snapshot in private history', async () => {
    ready();
    const n = net();
    const r = await productionRun(ENV, fixtureSources(), deps(n, T0));
    expect(r).toMatchObject({ status: 'publish', published: true });
    const snap = blob.stores.pub.get('current/snapshot.json')!;
    expect(JSON.parse(snap.body).mode).toBe('live');
    expect(snap.opts.cacheControlMaxAge).toBe(60);
    expect(blob.stores.pub.get('current/rss.xml')!.opts.cacheControlMaxAge).toBe(300);
    expect(blob.stores.pub.get('current/rss.xml')!.opts.access).toBe('public');
    expect([...blob.stores.priv.keys()].filter((k) => k.startsWith('history/'))).toHaveLength(1);
    expect([...blob.stores.pub.keys()].every((k) => k.startsWith('current/'))).toBe(true);
    expect(blob.stores.priv.get('state/state.json')).toBeDefined();
  });

  it('keeps the last good files during a drill, and records the drill', async () => {
    ready();
    const n = net();
    await productionRun(ENV, fixtureSources(), deps(n, T0));
    const before = blob.stores.pub.get('current/snapshot.json')!.body;
    setPriv('control.json', { collect: 'on', drill: 'keep-last-good' });
    const r = await productionRun(ENV, fixtureSources(), deps(n, T0 + 15 * 60_000));
    expect(r).toMatchObject({ status: 'kept-last-good', published: false });
    expect(blob.stores.pub.get('current/snapshot.json')!.body).toBe(before);
    const logs = [...blob.stores.priv.entries()].filter(([k]) => k.startsWith('ops/')).map(([, v]) => JSON.parse(v.body) as { drill: string | null });
    expect(logs.some((l) => l.drill === 'keep-last-good')).toBe(true);
  });

  it('lets only one of two overlapping runs go ahead', async () => {
    ready();
    const a = net();
    const b = net();
    const [ra, rb] = await Promise.all([productionRun(ENV, fixtureSources(), deps(a, T0)), productionRun(ENV, fixtureSources(), deps(b, T0))]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual(['publish', 'suspended']);
    expect([ra, rb].find((r) => r.status === 'suspended')!.reasons[0]).toMatch(/another run/);
    expect(Math.min(a.feeds(), b.feeds())).toBe(0);
  });
});

describe('publishing to Blob', () => {
  it('writes only the files whose content changed', async () => {
    const site = new BlobSiteStore({ token: 'pub' }, { token: 'priv' }, 24);
    const files = [{ path: 'snapshot.json', body: '{"a":1}', contentType: 'application/json' }, { path: 'rss.xml', body: '<rss/>', contentType: 'application/rss+xml' }];
    await site.publish(files, '20261122T120000000Z');
    const etag = blob.stores.pub.get('current/rss.xml')!.etag;
    await site.publish([{ ...files[0]!, body: '{"a":2}' }, files[1]!], '20261122T121500000Z');
    expect(site.stats).toMatchObject({ written: 3, unchanged: 1 });
    expect(blob.stores.pub.get('current/rss.xml')!.etag).toBe(etag);
  });

  it('keeps at most the configured number of earlier snapshots', async () => {
    const site = new BlobSiteStore({ token: 'pub' }, { token: 'priv' }, 2);
    for (let i = 0; i < 4; i++) await site.publish([{ path: 'snapshot.json', body: String(i), contentType: 'application/json' }], `2026112${i}T000000000Z`);
    expect([...blob.stores.priv.keys()].filter((k) => k.startsWith('history/')).sort()).toEqual(['history/20261122T000000000Z/snapshot.json', 'history/20261123T000000000Z/snapshot.json']);
  });
});

describe('the cron endpoint', () => {
  it('refuses a request without the right CRON_SECRET, before any work', async () => {
    const secret = 'x'.repeat(48);
    process.env.CRON_SECRET = secret;
    process.env.SIGNAL_INGEST = 'off';
    try {
      expect((await GET(new Request('https://example.test/api/collect'))).status).toBe(401);
      expect((await GET(new Request('https://example.test/api/collect', { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
      const ok = await GET(new Request('https://example.test/api/collect', { headers: { authorization: `Bearer ${secret}` } }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: 'suspended', published: false });
      process.env.CRON_SECRET = 'short';
      expect((await GET(new Request('https://example.test/api/collect', { headers: { authorization: 'Bearer short' } }))).status).toBe(401);
    } finally {
      delete process.env.CRON_SECRET;
      delete process.env.SIGNAL_INGEST;
    }
  });
});

describe('operations', () => {
  it('drops operations logs older than the retention window and keeps the rest', async () => {
    for (const day of ['20261101', '20261108', '20261109', '20261122']) setPriv(`ops/${day}/${day}T120000000Z.json`, {});
    const n = await pruneOpsLogs({ token: 'priv' }, new Date('2026-11-22T00:05:00Z'), 14);
    expect(n).toBe(1);
    expect([...blob.stores.priv.keys()].filter((k) => k.startsWith('ops/')).sort()).toEqual(['ops/20261108/20261108T120000000Z.json', 'ops/20261109/20261109T120000000Z.json', 'ops/20261122/20261122T120000000Z.json']);
  });

  it('rolls back to an earlier snapshot only while collection is off, rebuilding and checking its feeds', async () => {
    ready();
    const n = net();
    await productionRun(ENV, fixtureSources(), deps(n, T0));
    const first = [...blob.stores.priv.keys()].find((k) => k.startsWith('history/'))!.split('/')[1]!;
    const firstBody = blob.stores.pub.get('current/snapshot.json')!.body;
    await productionRun(ENV, fixtureSources(), deps(n, T0 + 15 * 60_000));
    expect(blob.stores.pub.get('current/snapshot.json')!.body).not.toBe(firstBody);
    await expect(rollback({ token: 'priv' }, { token: 'pub' }, fixtureSources(), first)).rejects.toThrow(/collection is on/);
    blob.stores.priv.delete('control.json');
    const broken: typeof buildAllFeeds = (snap, ctx) => buildAllFeeds(snap, ctx).map((d, i) => (i === 0 ? { ...d, xml: d.xml.replace('</channel>', '') } : d));
    const current = blob.stores.pub.get('current/snapshot.json')!.body;
    await expect(rollback({ token: 'priv' }, { token: 'pub' }, fixtureSources(), first, broken)).rejects.toThrow(/fail the RSS checks/);
    expect(blob.stores.pub.get('current/snapshot.json')!.body).toBe(current);
    expect(await rollback({ token: 'priv' }, { token: 'pub' }, fixtureSources(), first)).toMatch(/republished snapshot/);
    expect(blob.stores.pub.get('current/snapshot.json')!.body).toBe(firstBody);
    expect(blob.stores.pub.get('current/rss.xml')!.body).toContain('<rss version="2.0"');
  });

  it('rolls up the operations logs: outcomes, requests per host, failing sources and the longest gap between publishes', async () => {
    ready();
    const n = net();
    for (let i = 0; i < 3; i++) await productionRun(ENV, fixtureSources(), deps(n, T0 + i * 15 * 60_000));
    blob.stores.priv.delete('control.json');
    await productionRun(ENV, fixtureSources(), deps(n, T0 + 45 * 60_000));
    const entries = [...blob.stores.priv.entries()].filter(([k]) => k.startsWith('ops/')).map(([, v]) => JSON.parse(v.body));
    const sum = summarize(entries);
    expect(sum.runs).toBe(4);
    expect(sum.byStatus).toMatchObject({ publish: 3, stopped: 1 });
    expect(sum.published).toBe(3);
    expect(sum.longestGapBetweenPublishesMin).toBe(15);
    expect(sum.requests.feed).toBeGreaterThan(0);
    // Requests per host come from the request ledger, which only the real network layer writes.
    expect(sum.requests.perHost).toEqual({});
  });
});
