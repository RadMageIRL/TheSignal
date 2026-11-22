import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { smokeChecks } from '../../tools/smoke-prod.ts';
import { securityHeaders } from '../../tools/security-headers.ts';
import { runCollection } from '../../ingest/publish.ts';
import { DEFAULT_CONTROLS } from '../../ingest/controls.ts';
import type { Fetcher } from '../../ingest/run.ts';
import { filesOf } from '../../ingest/storage.ts';
import { fixtureSources } from '../fixtures/news-day.ts';

const T0 = Date.parse('2026-11-22T12:00:00Z');
const BASE = 'https://site.example/signal/';

async function liveFiles() {
  const fetcher: Fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { url, finalUrl: url, status: 404, ok: false, notModified: false, body: '', bytes: 0, ms: 1, error: 'HTTP 404' };
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://${u.host}/</link><item><title>Report from ${u.host} on the harbor works</title><link>https://${u.host}/news/1</link><pubDate>${new Date(T0 - 3600_000).toUTCString()}</pubDate></item></channel></rss>`;
    return { url, finalUrl: url, status: 200, ok: true, notModified: false, body, bytes: body.length, ms: 1 };
  };
  const r = await runCollection(fixtureSources(), { ...DEFAULT_CONTROLS, ingest: true, minArticles: 1, retryDelayMs: 0 }, new Date(T0), { fetcher, clock: () => T0, sleep: async () => {} });
  if (r.status !== 'publish') throw new Error(r.status);
  return new Map(filesOf(r).map((f) => [f.path, f]));
}

/** A fake deployed site: the built page with the production headers, and the published files. */
function site(files: Map<string, { body: string; contentType: string }>, over: { csp?: string } = {}) {
  const index = readFileSync('index.html', 'utf8');
  const headers = { ...securityHeaders(index), ...(over.csp !== undefined ? { 'Content-Security-Policy': over.csp } : {}) };
  return async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/signal/') return new Response(index, { headers: { ...headers, 'content-type': 'text/html' } });
    if (path === '/signal/THIRD-PARTY-NOTICES.txt') return new Response(readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8'));
    if (path === '/api/collect') return new Response('{"error":"unauthorized"}', { status: 401 });
    const rel = path === '/signal/data/snapshot.json' ? 'snapshot.json' : path.replace('/signal/', '');
    const f = files.get(rel);
    return f ? new Response(f.body, { headers: { 'content-type': f.contentType } }) : new Response('not found', { status: 404 });
  };
}

const registry = fixtureSources();

describe('post-deploy checks', () => {
  it('pass for a correctly deployed site', async () => {
    const files = await liveFiles();
    const checks = await smokeChecks(BASE, { get: site(files), registry, maxAgeMin: 45, apiUrl: 'https://site.example/api/collect', now: T0 + 10 * 60_000 });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThan(15);
  });

  it('fail for a stale snapshot, a missing policy, a prototype capture and a feed carrying a barred source', async () => {
    const files = await liveFiles();
    const stale = await smokeChecks(BASE, { get: site(files), registry, maxAgeMin: 45, now: T0 + 3 * 3600_000 });
    expect(stale.find((c) => /minutes old/.test(c.name))!.ok).toBe(false);
    const noCsp = await smokeChecks(BASE, { get: site(files, { csp: '' }), registry, maxAgeMin: 45, now: T0 });
    expect(noCsp.find((c) => /Content-Security-Policy/.test(c.name))!.ok).toBe(false);
    const snap = JSON.parse(files.get('snapshot.json')!.body) as { mode: string; sources: { id: string; syndicate?: boolean }[]; articles: { s: string; u: string }[] };
    const proto = new Map(files);
    proto.set('snapshot.json', { ...files.get('snapshot.json')!, body: JSON.stringify({ ...snap, mode: 'prototype' }) });
    expect((await smokeChecks(BASE, { get: site(proto), registry, maxAgeMin: 45, now: T0 })).find((c) => /live/.test(c.name))!.ok).toBe(false);
    const barred = snap.sources.find((s) => s.syndicate !== true)!;
    const leak = snap.articles.find((a) => a.s === barred.id)!;
    const rss = files.get('rss.xml')!;
    const tampered = new Map(files);
    tampered.set('rss.xml', { ...rss, body: rss.body.replace(/(<item>[\s\S]*?<link>)[^<]*(<\/link>)/, `$1${leak.u}$2`) });
    expect((await smokeChecks(BASE, { get: site(tampered), registry, maxAgeMin: 45, now: T0 })).find((c) => /redistributable/.test(c.name))!.ok).toBe(false);
  });

  it('fail when the snapshot carries a source that is not cleared for collection', async () => {
    const files = await liveFiles();
    const reg = fixtureSources();
    reg[0]!.enabled = false;
    const checks = await smokeChecks(BASE, { get: site(files), registry: reg, maxAgeMin: 45, now: T0 });
    expect(checks.find((c) => /cleared for collection/.test(c.name))!.ok).toBe(false);
  });
});
