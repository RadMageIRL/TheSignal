// Source validator. Fetches every candidate feed once, parses it with the same
// parser the ingestion job uses, and records operational facts: HTTP status, final URL
// after redirects, format, item count, newest item date, date coverage and robots.txt.
// Raw responses are saved under local/research/feeds/ (local only, never published).
//
//   node tools/validate-sources.ts [registry/sources.json] [--only id1,id2]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fetchFeed, runPool, type FetchPolicy } from '../ingest/fetch.ts';
import { parseXmlFeed, parseMastodonLinks, parseWikipediaTop, type ParseResult } from '../ingest/parse.ts';
import type { SourceEntry, FeedEndpoint } from '../shared/types.ts';
import { parseRobots, robotsAllows, type RobotsGroup } from '../ingest/robots.ts';
import { DEFAULT_USER_AGENT, ROBOTS_TOKEN, userAgentFor } from '../shared/identity.ts';

type Candidate = Pick<SourceEntry, 'id' | 'name' | 'homepage' | 'section' | 'country'> & { feeds: FeedEndpoint[] };

const args = process.argv.slice(2);
const onlyArg = args.indexOf('--only');
// The registry path is the first argument that is neither a flag nor the value of --only.
const registryPath = args.find((a, i) => !a.startsWith('--') && !(onlyArg >= 0 && i === onlyArg + 1)) ?? 'registry/sources.json';
const only = onlyArg >= 0 ? new Set((args[onlyArg + 1] ?? '').split(',')) : null;
const candidates = (JSON.parse(readFileSync(registryPath, 'utf8')) as Candidate[]).filter((c) => !only || only.has(c.id));

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
const outDir = join('local', 'research', 'feeds');
const rawDir = join(outDir, 'raw', stamp);
mkdirSync(rawDir, { recursive: true });

const UA = DEFAULT_USER_AGENT;

function fillTemplate(url: string): string {
  const y = new Date(now.getTime() - 26 * 3600_000); // yesterday's complete UTC day
  return url
    .replace('{Y}', String(y.getUTCFullYear()))
    .replace('{M}', String(y.getUTCMonth() + 1).padStart(2, '0'))
    .replace('{D}', String(y.getUTCDate()).padStart(2, '0'));
}

// Validation follows redirects to any public host (so it can discover them) but records the
// final host; production only allows hosts declared in the registry.
const allHosts = new Set<string>();
for (const c of candidates) for (const f of c.feeds) allHosts.add(new URL(fillTemplate(f.url)).hostname.toLowerCase());
const discoveryPolicy: FetchPolicy = {
  allowHosts: new Proxy(allHosts, { get: (t, p) => (p === 'has' ? () => true : Reflect.get(t, p)) }) as Set<string>,
  userAgent: UA,
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
};

// --- robots.txt -----------------------------------------------------------------
const robotsCache = new Map<string, Promise<RobotsGroup[] | null>>();
function robotsFor(origin: string): Promise<RobotsGroup[] | null> {
  let p = robotsCache.get(origin);
  if (!p) {
    p = (async () => {
      const r = await fetchFeed(origin + '/robots.txt', discoveryPolicy, { userAgent: origin.includes('sec.gov') ? userAgentFor('sec') : DEFAULT_USER_AGENT });
      if (r.status === 404 || r.status === 410) return [];
      if (!r.ok || !r.body) return null;
      return parseRobots(r.body);
    })();
    robotsCache.set(origin, p);
  }
  return p;
}

interface FeedResult {
  sourceId: string;
  name: string;
  section: string;
  url: string;
  finalUrl: string;
  finalHost: string;
  status: number;
  error?: string;
  ms: number;
  bytes: number;
  format: string;
  items: number;
  datedItems: number;
  newest: string | null;
  newestAgeHours: number | null;
  problems: string[];
  robots: boolean | null;
  robotsRule?: string;
  samples: string[];
  verdict: 'ok' | 'stale' | 'empty' | 'failed' | 'blocked';
}

const tasks = candidates.flatMap((c) => c.feeds.map((f, i) => ({ c, f, i })));

const results = await runPool(
  tasks,
  (t) => new URL(fillTemplate(t.f.url)).hostname,
  async ({ c, f, i }): Promise<FeedResult> => {
    const url = fillTemplate(f.url);
    const r = await fetchFeed(url, discoveryPolicy, { allowTruncate: f.kind === 'podcast', userAgent: userAgentFor(c.id) });
    const base = {
      sourceId: c.id, name: c.name, section: c.section, url, finalUrl: r.finalUrl,
      finalHost: new URL(r.finalUrl).hostname, status: r.status, ms: r.ms, bytes: r.bytes,
    };
    const u = new URL(r.finalUrl);
    const groups = await robotsFor(u.origin);
    const rv = groups === null ? null : robotsAllows(groups, ROBOTS_TOKEN, u.pathname + u.search);
    const robots = rv === null ? null : rv.allowed;
    const robotsRule = rv?.matched ? (rv.matched.allow ? 'Allow: ' : 'Disallow: ') + rv.matched.pattern : undefined;
    if (!r.ok) {
      const blocked = r.status === 401 || r.status === 403 || r.status === 429 || /challenge|captcha/i.test(r.error ?? '');
      return { ...base, error: r.error, format: '-', items: 0, datedItems: 0, newest: null, newestAgeHours: null,
        problems: [], robots, robotsRule, samples: [], verdict: blocked ? 'blocked' : 'failed' };
    }
    writeFileSync(join(rawDir, `${c.id}-${i}.txt`), r.body);
    let p: ParseResult;
    if (f.kind === 'mastodon-links') p = parseMastodonLinks(r.body, u.hostname, now);
    else if (f.kind === 'wikipedia-top') p = parseWikipediaTop(r.body, 'en.wikipedia.org', now);
    else p = parseXmlFeed(r.body, r.finalUrl, now, { truncated: r.truncated, linkFallbackToChannel: f.kind === 'podcast', fallbackLink: c.homepage });
    const dated = p.items.filter((x) => x.publishedAt).map((x) => Date.parse(x.publishedAt!));
    const newestMs = dated.length ? Math.max(...dated) : null;
    const ageH = newestMs === null ? null : Math.round(((now.getTime() - newestMs) / 3600_000) * 10) / 10;
    const challenge = /<title>\s*(Just a moment|Attention Required|Access denied)/i.test(r.body.slice(0, 3000));
    let verdict: FeedResult['verdict'] = 'ok';
    if (challenge) verdict = 'blocked';
    else if (p.items.length === 0) verdict = 'empty';
    else if (ageH !== null && ageH > 24 * 30) verdict = 'stale';
    return {
      ...base, format: p.format, items: p.items.length, datedItems: dated.length,
      newest: newestMs === null ? null : new Date(newestMs).toISOString(), newestAgeHours: ageH,
      problems: [...new Set(p.problems)].slice(0, 5), robots, robotsRule, samples: p.items.slice(0, 2).map((x) => x.title), verdict,
    };
  },
  8,
  2,
);

const summary = {
  generatedAt: now.toISOString(),
  userAgent: UA,
  registry: registryPath,
  totals: {
    sources: candidates.length,
    feeds: results.length,
    ok: results.filter((r) => r.verdict === 'ok').length,
    stale: results.filter((r) => r.verdict === 'stale').length,
    empty: results.filter((r) => r.verdict === 'empty').length,
    failed: results.filter((r) => r.verdict === 'failed').length,
    blocked: results.filter((r) => r.verdict === 'blocked').length,
    robotsDisallowed: results.filter((r) => r.robots === false).length,
  },
  results,
};
const outFile = join(outDir, `validation-${stamp}.json`);
writeFileSync(outFile, JSON.stringify(summary, null, 1));
// validation-latest.json accumulates: a partial rerun (--only) replaces just its own rows.
const latestPath = join(outDir, 'validation-latest.json');
let merged = results;
if (only && existsSync(latestPath)) {
  const prev = JSON.parse(readFileSync(latestPath, 'utf8')) as { results: FeedResult[] };
  const fresh = new Set(results.map((r) => r.url));
  merged = [...prev.results.filter((r) => !fresh.has(r.url)), ...results];
}
writeFileSync(latestPath, JSON.stringify({ ...summary, partialRerun: !!only, results: merged }, null, 1));

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '~' : s.padEnd(n));
for (const r of results) {
  console.log(
    pad(r.verdict, 8), pad(r.sourceId, 22), String(r.status).padStart(3), pad(r.format, 5),
    String(r.items).padStart(3), pad(r.newestAgeHours === null ? '-' : `${r.newestAgeHours}h`, 9),
    r.robots === false ? 'ROBOTS-NO' : '         ', pad(r.error ?? r.finalHost, 40),
  );
}
console.log(JSON.stringify(summary.totals));
console.log('wrote', outFile);
