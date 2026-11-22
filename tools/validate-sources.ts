// Source validator. Fetches every candidate feed once, parses it with the same
// parser the ingestion job uses, and records operational facts: HTTP status, final URL
// after redirects, format, item count, newest item date, date coverage and robots.txt.
// Raw responses are saved under local/research/feeds/ (local only, never published).
//
//   node tools/validate-sources.ts [registry/sources.json] [--only id1,id2]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchFeed, runPool, type Fetcher, type FetchPolicy } from '../ingest/fetch.ts';
import { parseXmlFeed, parseMastodonLinks, parseWikipediaTop, type ParseResult } from '../ingest/parse.ts';
import type { SourceEntry, FeedEndpoint } from '../shared/types.ts';
import { createRobotsGate, type RobotsGate } from '../ingest/robots.ts';
import { DEFAULT_USER_AGENT, ROBOTS_TOKEN, userAgentFor } from '../shared/identity.ts';

type Candidate = Pick<SourceEntry, 'id' | 'name' | 'homepage' | 'section' | 'country'> & { feeds: FeedEndpoint[] };

export interface FeedResult {
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
  /** true allowed, false disallowed by a rule, null unreachable (which also means not requested). */
  robots: boolean | null;
  robotsRule?: string;
  samples: string[];
  verdict: 'ok' | 'stale' | 'empty' | 'failed' | 'blocked' | 'disallowed';
}

export function fillTemplate(url: string, now: Date): string {
  const y = new Date(now.getTime() - 26 * 3600_000); // yesterday's complete UTC day
  return url
    .replace('{Y}', String(y.getUTCFullYear()))
    .replace('{M}', String(y.getUTCMonth() + 1).padStart(2, '0'))
    .replace('{D}', String(y.getUTCDate()).padStart(2, '0'));
}

/**
 * Validate one feed. robots.txt for the feed's origin is read and evaluated FIRST; a feed it
 * disallows (or whose robots.txt is unreachable) is never requested, and every redirect hop is
 * checked the same way before it is followed.
 */
export async function checkFeed(
  c: Candidate, f: FeedEndpoint, now: Date,
  deps: { fetcher: Fetcher; policy: FetchPolicy; robots: RobotsGate; save?: (body: string) => void },
): Promise<FeedResult> {
  const url = fillTemplate(f.url, now);
  const userAgent = userAgentFor(c.id);
  const empty = { format: '-', items: 0, datedItems: 0, newest: null, newestAgeHours: null, problems: [], samples: [] };
  const first = await deps.robots.check(url, userAgent);
  if (!first.allowed) {
    return {
      sourceId: c.id, name: c.name, section: c.section, url, finalUrl: url, finalHost: new URL(url).hostname,
      status: 0, ms: 0, bytes: 0, error: first.reason, ...empty,
      robots: first.basis === 'unreachable' ? null : false, robotsRule: first.rule, verdict: 'disallowed',
    };
  }
  const deferred = await deps.robots.pace(url, userAgent);
  if (deferred) {
    return {
      sourceId: c.id, name: c.name, section: c.section, url, finalUrl: url, finalHost: new URL(url).hostname,
      status: 0, ms: 0, bytes: 0, error: deferred, ...empty, robots: true, robotsRule: first.rule, verdict: 'failed',
    };
  }
  let hopRefusal: { robots: boolean | null; rule?: string } | undefined;
  const r = await deps.fetcher(url, deps.policy, {
    allowTruncate: f.kind === 'podcast',
    userAgent,
    permitRedirect: async (next) => {
      const v = await deps.robots.check(next.toString(), userAgent);
      if (v.allowed) return null;
      hopRefusal = { robots: v.basis === 'unreachable' ? null : false, rule: v.rule };
      return v.reason!;
    },
  });
  const u = new URL(r.finalUrl);
  const base = {
    sourceId: c.id, name: c.name, section: c.section, url, finalUrl: r.finalUrl,
    finalHost: u.hostname, status: r.status, ms: r.ms, bytes: r.bytes,
  };
  if (hopRefusal) return { ...base, error: r.error, ...empty, robots: hopRefusal.robots, robotsRule: hopRefusal.rule, verdict: 'disallowed' };
  // Already evaluated before the final URL was requested (above, or in permitRedirect); this
  // reads the same answer back for the report.
  const fin = await deps.robots.check(r.finalUrl, userAgent);
  const robots = fin.basis === 'unreachable' ? null : fin.allowed;
  const robotsRule = fin.rule;
  if (!r.ok) {
    const blocked = r.status === 401 || r.status === 403 || r.status === 429 || /challenge|captcha/i.test(r.error ?? '');
    return { ...base, error: r.error, ...empty, robots, robotsRule, verdict: blocked ? 'blocked' : 'failed' };
  }
  deps.save?.(r.body);
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
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) await main();

async function main(): Promise<void> {
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

// Validation follows redirects to any public host (so it can discover them) but records the
// final host; production only allows hosts declared in the registry. robots.txt is still read
// and evaluated for every host before anything else is requested from it.
const allHosts = new Set<string>();
for (const c of candidates) for (const f of c.feeds) allHosts.add(new URL(fillTemplate(f.url, now)).hostname.toLowerCase());
const discoveryPolicy: FetchPolicy = {
  allowHosts: new Proxy(allHosts, { get: (t, p) => (p === 'has' ? () => true : Reflect.get(t, p)) }) as Set<string>,
  userAgent: UA,
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
};
// A manual run waits out even long Crawl-delays (up to 10 minutes) rather than skipping a feed.
const robots = createRobotsGate(fetchFeed, discoveryPolicy, { now, token: ROBOTS_TOKEN, maxWaitMs: 600_000 });

const tasks = candidates.flatMap((c) => c.feeds.map((f, i) => ({ c, f, i })));

const results = await runPool(
  tasks,
  (t) => new URL(fillTemplate(t.f.url, now)).hostname,
  ({ c, f, i }) => checkFeed(c, f, now, {
    fetcher: fetchFeed, policy: discoveryPolicy, robots,
    save: (body) => writeFileSync(join(rawDir, `${c.id}-${i}.txt`), body),
  }),
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
    notRequested: results.filter((r) => r.verdict === 'disallowed').length,
    robotsRequests: robots.stats.requests,
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
}
