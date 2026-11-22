// Post-deploy checks against a running site (production, or the local preview of a capture).
// Fetches only The Signal's own pages and files, never a publisher.
//
//   node tools/smoke-prod.ts --base https://radmagelabs.com/signal/ [--max-age-min 45] [--api https://<project>.vercel.app/api/collect]
//
// Checks: the page and its security headers; the snapshot (schema, live mode, age, sources
// cleared for collection only); every RSS feed (status, type, well-formed, every item from a
// source that allows redistribution, non-English items marked); the notices file; and that the
// collector endpoint refuses an unauthenticated call.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceEntry } from '../shared/types.ts';
import { validateWire } from '../shared/schema.ts';
import { snapshotFromWire, type WireSnapshot } from '../shared/wire.ts';
import { FEED_SPECS, feedUrl } from '../shared/feeds.ts';
import { collectable } from '../shared/registry.ts';
import { rssProblems } from '../ingest/publish.ts';
import type { RssDocument } from '../shared/rss.ts';
import { isEnglish } from '../shared/languages.ts';

export interface Check { name: string; ok: boolean; detail: string }

export type Get = (url: string, init?: RequestInit) => Promise<Response>;

/** The only way these tools reach the network: the site under test (and its collector endpoint), never a publisher. */
export function siteGet(base: string, apiUrl?: string): Get {
  const allowed = new Set([new URL(base).origin, ...(apiUrl ? [new URL(apiUrl).origin] : [])]);
  return (u, i) => {
    if (!allowed.has(new URL(u).origin)) throw new Error(`refusing ${u}: not the site under test`);
    return fetch(u, { ...i, redirect: 'manual' });
  };
}

export async function smokeChecks(base: string, opts: { get: Get; registry: SourceEntry[]; maxAgeMin: number; apiUrl?: string; now?: number }): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail = '') => { out.push({ name, ok, detail }); };
  const url = (p: string) => new URL(p, base).toString();

  const page = await opts.get(url('./'));
  const html = await page.text();
  add('page answers 200', page.status === 200, String(page.status));
  add('page is the app', html.includes('<div id="root">') || html.includes('id="root"'), '');
  const csp = page.headers.get('content-security-policy') ?? '';
  add('Content-Security-Policy is sent', csp.includes("default-src 'none'") && !csp.includes('unsafe-inline'), csp.slice(0, 80));
  add('nosniff and frame protection are sent', page.headers.get('x-content-type-options') === 'nosniff' && page.headers.get('x-frame-options') === 'DENY', '');

  const snapRes = await opts.get(url('data/snapshot.json'));
  add('snapshot answers 200 as JSON', snapRes.status === 200 && (snapRes.headers.get('content-type') ?? '').includes('json'), `${snapRes.status} ${snapRes.headers.get('content-type')}`);
  let wire: WireSnapshot | null = null;
  try { wire = await snapRes.json() as WireSnapshot; } catch { add('snapshot parses', false, 'not JSON'); }
  if (wire) {
    const problems = validateWire(wire);
    add('snapshot passes the schema', problems.length === 0, problems.slice(0, 3).join('; '));
    add('snapshot is live, not a prototype capture', wire.mode === 'live', wire.mode);
    const ageMin = ((opts.now ?? Date.now()) - Date.parse(wire.generatedAt)) / 60_000;
    add(`snapshot is under ${opts.maxAgeMin} minutes old`, ageMin <= opts.maxAgeMin, `${Math.round(ageMin)} min`);
    const cleared = new Set(collectable(opts.registry).map((s) => s.id));
    const stray = [...new Set(wire.articles.map((a) => a.s))].filter((s) => !cleared.has(s));
    add('every headline comes from a source cleared for collection', stray.length === 0, stray.join(', '));
    const snap = snapshotFromWire(wire);
    const docs: RssDocument[] = [];
    for (const spec of FEED_SPECS) {
      const res = await opts.get(feedUrl(spec).replace('https://radmagelabs.com/signal/', base));
      const xml = await res.text();
      add(`${spec.path} answers 200 as RSS`, res.status === 200 && (res.headers.get('content-type') ?? '').includes('rss+xml'), `${res.status} ${res.headers.get('content-type')}`);
      docs.push({ spec, xml, items: (xml.match(/<item>/g) ?? []).length, bytes: xml.length, excluded: 0 });
    }
    const rss = rssProblems(docs, snap);
    add('every feed is well-formed RSS 2.0 with only redistributable sources', rss.length === 0, rss.slice(0, 3).join('; '));
    const byUrl = new Map(snap.articles.map((a) => [a.url, a] as const));
    let unmarked = 0;
    for (const d of docs) for (const block of d.xml.split('<item>').slice(1)) {
      const link = /<link>([^<]*)<\/link>/.exec(block)?.[1]?.replace(/&amp;/g, '&');
      const a = link ? byUrl.get(link) : undefined;
      if (a && !isEnglish(a.language) && !block.includes('<dc:language>')) unmarked++;
    }
    add('non-English feed items carry dc:language', unmarked === 0, `${unmarked} unmarked`);
  }
  const notices = await opts.get(url('THIRD-PARTY-NOTICES.txt'));
  add('third-party notices are published', notices.status === 200 && (await notices.text()).length > 1000, String(notices.status));
  if (opts.apiUrl) {
    const api = await opts.get(opts.apiUrl);
    add('the collector refuses an unauthenticated call', api.status === 401, String(api.status));
  }
  return out;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n: string, d?: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const base = opt('--base');
  if (!base || !base.endsWith('/')) { console.error('usage: node tools/smoke-prod.ts --base https://host/signal/'); process.exit(1); }
  const registry = JSON.parse(readFileSync('registry/sources.json', 'utf8')) as SourceEntry[];
  const apiUrl = opt('--api');
  const checks = await smokeChecks(base, { get: siteGet(base, apiUrl), registry, maxAgeMin: Number(opt('--max-age-min', '45')), apiUrl });
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? `all ${checks.length} checks passed` : `${failed} of ${checks.length} checks failed`);
  process.exit(failed === 0 ? 0 : 1);
}
