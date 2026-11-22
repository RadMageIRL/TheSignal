// Local stand-in for scheduled production collection, with an audit of every request sent.
// Each run is a separate process that reads and writes only its folder: the collector state, a
// request ledger, a run log, and the published site (current files plus history). The audit
// replays the ledger against the registry and the saved robots.txt answers and stops the smoke
// test at the first policy violation.
//
//   node tools/collect-local.ts run --out <dir> [--run <n>]     one collection run
//   node tools/collect-local.ts audit --out <dir>                check every request so far
//   node tools/collect-local.ts report --out <dir>               evidence summary (JSON)
//   node tools/collect-local.ts smoke --out <dir> [--every 15]   the scripted smoke test
//
// Only the sources cleared for production (enabled, READY, no gates) are collected, with the
// declared identity and the production limits. Nothing here is deployed or scheduled.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { SourceEntry } from '../shared/types.ts';
import type { RequestEvent } from '../ingest/fetch.ts';
import { collectable } from '../shared/registry.ts';
import { readControls } from '../ingest/controls.ts';
import { runCollection, rssProblems, type RunOutcome } from '../ingest/publish.ts';
import type { RssDocument } from '../shared/rss.ts';
import { allowlistFor, fillTemplate } from '../ingest/run.ts';
import { FileStateStore, decodeState, feedKey, COOL_DOWN_MS, type CollectorState } from '../ingest/state.ts';
import { DirSiteStore, deliver } from '../ingest/storage.ts';
import { crawlDelayOf, robotsAllows, ROBOTS_MAX_AGE_MS } from '../ingest/robots.ts';
import { ROBOTS_TOKEN, userAgentFor, DEFAULT_USER_AGENT } from '../shared/identity.ts';
import { snapshotFromWire, type WireSnapshot } from '../shared/wire.ts';
import { isEnglish } from '../shared/languages.ts';
import { safeLink } from '../shared/url.ts';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, dflt?: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const out = resolve(opt('--out', 'local/smoke/latest')!);
const registryPath = opt('--registry', 'registry/sources.json')!;
const P = {
  state: join(out, 'state.json'),
  ledger: join(out, 'ledger.jsonl'),
  runs: join(out, 'runs.jsonl'),
  site: join(out, 'site'),
  log: join(out, 'smoke.log'),
};

type LedgerLine = RequestEvent & { run: number };
interface RunLine {
  run: number; startedAt: string; finishedAt: string; status: RunOutcome['status']; reasons: string[]; published: boolean;
  notes: string[]; traffic?: unknown; feeds?: unknown[]; health?: { sourceId: string; ok: boolean; status: string; items: number; error?: string }[];
  stats?: unknown; wallMs: number; cpuUserMs: number; cpuSystemMs: number; maxRssKb: number; stateBytes: number;
  currentSnapshotSha?: string; snapshotBytes?: number; rssBytes?: number; articles?: number; undated?: number; nonEnglish?: number;
  perspectives?: number; trending?: number; multiSourceStories?: number; env: Record<string, string>;
}

const readJsonl = <T>(path: string): T[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []);
const sha = (path: string) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16) : undefined);
const registry = () => JSON.parse(readFileSync(registryPath, 'utf8')) as SourceEntry[];

async function runOnce(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const run = Number(opt('--run', String(readJsonl<RunLine>(P.runs).length + 1)));
  const started = Date.now();
  const now = new Date(started);
  const env: Record<string, string> = { SIGNAL_INGEST: 'on' };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('SIGNAL_') && v !== undefined) env[k] = v;
  const { controls, warnings } = readControls(env);
  const outcome = await runCollection(registry(), controls, now, {
    store: new FileStateStore(P.state),
    observe: (e) => appendFileSync(P.ledger, JSON.stringify({ run, ...e }) + '\n'),
  });
  const published = await deliver(outcome, new DirSiteStore(P.site, controls.historyKeep), now);
  const usage = process.resourceUsage();
  const line: RunLine = {
    run, startedAt: now.toISOString(), finishedAt: new Date().toISOString(), status: outcome.status, reasons: outcome.reasons,
    published, notes: [...warnings, ...('report' in outcome && outcome.report ? outcome.report.notes : [])],
    wallMs: Date.now() - started, cpuUserMs: Math.round(usage.userCPUTime / 1000), cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
    maxRssKb: usage.maxRSS, stateBytes: existsSync(P.state) ? statSync(P.state).size : 0, env,
    currentSnapshotSha: sha(join(P.site, 'current', 'snapshot.json')),
  };
  if (outcome.status === 'publish' || outcome.status === 'kept-last-good') {
    line.traffic = outcome.traffic;
    line.health = outcome.health.map((h) => ({ sourceId: h.sourceId, ok: h.ok, status: h.status, items: h.items, error: h.error }));
    line.stats = outcome.stats;
    line.feeds = outcome.report?.feeds;
  }
  if (outcome.status === 'publish') {
    const w = JSON.parse(outcome.snapshotJson) as WireSnapshot;
    const langOf = new Map(w.sources.map((s) => [s.id, s.language] as const));
    Object.assign(line, {
      snapshotBytes: outcome.snapshotJson.length, rssBytes: outcome.feeds.reduce((n, d) => n + d.bytes, 0),
      articles: w.articles.length, undated: w.articles.filter((a) => a.p === null).length,
      nonEnglish: w.articles.filter((a) => !isEnglish(langOf.get(a.s) ?? 'en')).length,
      perspectives: w.perspectives.length, trending: w.trending.length, multiSourceStories: w.stats.multiSourceClusters,
    });
  }
  appendFileSync(P.runs, JSON.stringify(line) + '\n');
  console.log(JSON.stringify({ run, status: line.status, published, reasons: line.reasons.slice(0, 3), traffic: line.traffic, wallMs: line.wallMs }));
}

// --- Audit -------------------------------------------------------------------------------

export interface Violation { rule: string; detail: string }

function feedMatcher(sources: SourceEntry[]) {
  const exact = new Map<string, { s: SourceEntry; key: string }>();
  const templated: { re: RegExp; s: SourceEntry; key: string }[] = [];
  for (const s of sources) for (const f of s.feeds) {
    const key = feedKey(s.id, f.url);
    if (f.url.includes('{')) {
      const re = new RegExp('^' + f.url.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c).replace(/\\\{[YMD]\\\}/g, '\\d+') + '$');
      templated.push({ re, s, key });
    } else exact.set(f.url, { s, key });
  }
  return (url: string) => exact.get(url) ?? templated.find((t) => t.re.test(url));
}

export function auditLedger(ledger: LedgerLine[], runs: RunLine[], sources: SourceEntry[], state: CollectorState, retries: number): Violation[] {
  const v: Violation[] = [];
  const sent = ledger.filter((e) => e.phase === 'sent').sort((a, b) => a.sentAt - b.sentAt);
  const done = ledger.filter((e) => e.phase === 'done');
  const statusOf = (e: LedgerLine) => done.find((d) => d.run === e.run && d.url === e.url && d.target === e.target && d.sentAt === e.sentAt)?.status;
  const allow = allowlistFor(sources, new Date(sent[0]?.sentAt ?? Date.now()));
  const agents = new Set([DEFAULT_USER_AGENT, ...sources.map((s) => userAgentFor(s.id))]);
  const feedOf = feedMatcher(sources);
  const isRobots = (e: LedgerLine) => e.url === new URL(e.url).origin + '/robots.txt';

  // Requests in runs that must not have sent any.
  const quiet = new Set(runs.filter((r) => r.status === 'too-soon' || r.status === 'suspended').map((r) => r.run));
  for (const e of sent) if (quiet.has(e.run)) v.push({ rule: 'no requests in a refused run', detail: `run ${e.run} sent ${e.target}` });

  for (const e of sent) {
    const t = new URL(e.target);
    if (!allow.has(t.hostname.toLowerCase())) v.push({ rule: 'allowlist', detail: `${e.target} is not a registry host` });
    if (!agents.has(e.userAgent)) v.push({ rule: 'declared identity', detail: `${e.target} sent User-Agent ${e.userAgent}` });
    // Reading robots.txt, including following its redirects (RFC 9309 2.3.1.2), needs no robots.txt of its own.
    if (isRobots(e)) continue;
    // robots.txt first: read for this origin before this request, cacheable, and allowing the path.
    const origin = t.origin;
    const robotsBefore = sent.filter((r) => isRobots(r) && r.hop === 0 && new URL(r.url).origin === origin && r.sentAt < e.sentAt);
    const cached = state.robots[origin];
    if (robotsBefore.length === 0 && !(cached && Date.parse(cached.fetchedAt) < e.sentAt)) {
      v.push({ rule: 'robots.txt first', detail: `${e.target} sent with no robots.txt read for ${origin}` });
      continue;
    }
    if (!cached) { v.push({ rule: 'robots.txt first', detail: `${e.target} sent although ${origin} robots.txt gave no usable answer` }); continue; }
    if (cached.policy.kind === 'rules') {
      const verdict = robotsAllows(cached.policy.groups, ROBOTS_TOKEN, t.pathname + t.search);
      if (!verdict.allowed) v.push({ rule: 'robots.txt rules', detail: `${e.target} is disallowed (${verdict.matched?.pattern})` });
    }
  }

  // Crawl-delay: every pair of consecutive requests to an origin, across runs.
  const byOrigin = new Map<string, LedgerLine[]>();
  for (const e of sent) { const o = new URL(e.target).origin; byOrigin.set(o, [...(byOrigin.get(o) ?? []), e]); }
  for (const [o, list] of byOrigin) {
    const delay = crawlDelayOf(state.robots[o]?.policy, ROBOTS_TOKEN);
    if (delay <= 0) continue;
    for (let i = 1; i < list.length; i++) {
      const gap = list[i]!.sentAt - list[i - 1]!.sentAt;
      if (gap < delay * 1000) v.push({ rule: 'Crawl-delay', detail: `${o}: ${gap} ms between requests, Crawl-delay ${delay} s` });
    }
  }

  // Robots.txt itself: at most once a day per origin, unless the previous answer was unusable or
  // came in a run that was killed before it could save the answer.
  const killed = new Set(runs.filter((r) => (r.status as string) === 'killed').map((r) => r.run));
  for (const [o, list] of byOrigin) {
    const robots = list.filter((e) => isRobots(e) && e.hop === 0);
    for (let i = 1; i < robots.length; i++) {
      const prev = robots[i - 1]!;
      // The answer the chain ended with: a redirect the collector did not follow (off the
      // allowlist) is as unusable as a server error, and RFC 9309 lets the crawler ask again.
      const chain = done.filter((d) => d.run === prev.run && d.url === prev.url && d.sentAt >= prev.sentAt).sort((a, b) => b.sentAt - a.sentAt);
      const st = chain[0]?.status ?? statusOf(prev) ?? 0;
      const unusable = st === 0 || (st >= 300 && st < 400) || st >= 500 || st === 419 || st === 429 || killed.has(prev.run);
      if (!unusable && robots[i]!.sentAt - prev.sentAt < ROBOTS_MAX_AGE_MS) v.push({ rule: 'robots.txt cache', detail: `${o}/robots.txt re-read after ${robots[i]!.sentAt - prev.sentAt} ms` });
    }
  }

  // Intervals: the first request for a feed in each run, compared with the previous run's.
  const firstPerRun = new Map<string, LedgerLine[]>();
  const attempts = new Map<string, number>();
  for (const e of sent) {
    if (e.hop !== 0 || isRobots(e)) continue;
    const f = feedOf(e.url);
    if (!f) { v.push({ rule: 'unexpected request', detail: `${e.url} is not a registry feed` }); continue; }
    const k = `${f.key}#${e.run}`;
    attempts.set(k, (attempts.get(k) ?? 0) + 1);
    if (attempts.get(k) === 1) firstPerRun.set(f.key, [...(firstPerRun.get(f.key) ?? []), e]);
  }
  for (const [k, n] of attempts) if (n > 1 + retries) v.push({ rule: 'retries', detail: `${k}: ${n} attempts in one run` });
  for (const [key, list] of firstPerRun) {
    const f = feedOf(list[0]!.url)!;
    for (let i = 1; i < list.length; i++) {
      const gap = list[i]!.sentAt - list[i - 1]!.sentAt;
      if (gap < f.s.intervalMinutes * 60_000) v.push({ rule: 'polling interval', detail: `${key}: ${Math.round(gap / 1000)} s between polls, interval ${f.s.intervalMinutes} min` });
    }
  }

  // Cool-down: nothing to an origin for a day after it answered 419 or 429.
  for (const e of done) {
    if (e.status !== 419 && e.status !== 429) continue;
    const o = new URL(e.target).origin;
    for (const x of byOrigin.get(o) ?? []) {
      if (x.sentAt > e.sentAt && x.sentAt - e.sentAt < COOL_DOWN_MS) v.push({ rule: 'cool-down', detail: `${x.target} sent ${x.sentAt - e.sentAt} ms after HTTP ${e.status}` });
    }
  }
  return v;
}

/** The published feeds as they stand: well-formed, redistribution-eligible, non-English items marked. */
export function auditSite(siteDir: string): Violation[] {
  const v: Violation[] = [];
  const cur = join(siteDir, 'current');
  if (!existsSync(join(cur, 'snapshot.json'))) return v;
  const snap = snapshotFromWire(JSON.parse(readFileSync(join(cur, 'snapshot.json'), 'utf8')) as WireSnapshot);
  const files = ['rss.xml', ...(existsSync(join(cur, 'rss')) ? readdirSync(join(cur, 'rss')).map((f) => `rss/${f}`) : [])];
  const docs = files.map((path) => {
    const xml = readFileSync(join(cur, path), 'utf8');
    const items = (xml.match(/<item>/g) ?? []).length;
    return { spec: { path } as RssDocument['spec'], xml, items, bytes: xml.length, excluded: 0 };
  });
  for (const p of rssProblems(docs, snap)) v.push({ rule: 'RSS eligibility', detail: p });
  const byUrl = new Map(snap.articles.map((a) => [safeLink(a.url) ?? a.url, a] as const));
  for (const d of docs) {
    for (const block of d.xml.split('<item>').slice(1)) {
      const link = /<link>([^<]*)<\/link>/.exec(block)?.[1]?.replace(/&amp;/g, '&');
      const a = link ? byUrl.get(link) : undefined;
      if (a && !isEnglish(a.language) && !block.includes(`<dc:language>${a.language}</dc:language>`)) {
        v.push({ rule: 'RSS language', detail: `${d.spec.path}: ${link} has no dc:language` });
      }
    }
  }
  return v;
}

function audit(): Violation[] {
  const st = existsSync(P.state) ? decodeState(readFileSync(P.state, 'utf8')) : null;
  const state = st?.state ?? { robots: {} } as CollectorState;
  const { controls } = readControls({ SIGNAL_INGEST: 'on' });
  return [
    ...auditLedger(readJsonl<LedgerLine>(P.ledger), readJsonl<RunLine>(P.runs), collectable(registry()), state, controls.retries),
    ...auditSite(P.site),
  ];
}

// --- Evidence summary ------------------------------------------------------------------

function report() {
  const sources = collectable(registry());
  const runs = readJsonl<RunLine>(P.runs);
  const ledger = readJsonl<LedgerLine>(P.ledger);
  const sent = ledger.filter((e) => e.phase === 'sent');
  const done = ledger.filter((e) => e.phase === 'done');
  const state = existsSync(P.state) ? decodeState(readFileSync(P.state, 'utf8')).state : undefined;
  const feedOf = feedMatcher(sources);
  const isRobots = (e: LedgerLine) => e.url === new URL(e.url).origin + '/robots.txt';

  const perHost: Record<string, { feed: number; robots: number; hops: number }> = {};
  for (const e of sent) {
    const h = new URL(e.target).host;
    perHost[h] ??= { feed: 0, robots: 0, hops: 0 };
    if (e.hop > 0) perHost[h].hops++;
    else if (isRobots(e)) perHost[h].robots++;
    else perHost[h].feed++;
  }
  // Effective polling: minutes between a feed's first request in successive runs.
  const polls = new Map<string, number[]>();
  for (const e of sent.filter((x) => x.hop === 0 && !isRobots(x)).sort((a, b) => a.sentAt - b.sentAt)) {
    const f = feedOf(e.url);
    if (!f) continue;
    const list = polls.get(f.key) ?? [];
    if (!list.length || ledger.find((x) => x.phase === 'sent' && x.sentAt === list.at(-1))?.run !== e.run) list.push(e.sentAt);
    polls.set(f.key, list);
  }
  const intervals: Record<string, { interval: number; polls: number; gapsMin: number[] }> = {};
  for (const s of sources) for (const f of s.feeds) {
    const list = polls.get(feedKey(s.id, f.url)) ?? [];
    intervals[`${s.id} ${f.url}`] = { interval: s.intervalMinutes, polls: list.length, gapsMin: list.slice(1).map((t, i) => Math.round((t - list[i]!) / 600) / 100) };
  }
  const delays: Record<string, { crawlDelaySec: number; requests: number; minGapSec: number | null }> = {};
  if (state) for (const [o, r] of Object.entries(state.robots)) {
    const d = crawlDelayOf(r.policy, ROBOTS_TOKEN);
    if (d <= 0) continue;
    const times = sent.filter((e) => new URL(e.target).origin === o).map((e) => e.sentAt).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => (t - times[i]!) / 1000);
    delays[o] = { crawlDelaySec: d, requests: times.length, minGapSec: gaps.length ? Math.min(...gaps) : null };
  }
  const redirects = sent.filter((e) => e.hop > 0).map((e) => ({ from: e.url, to: e.target, status: done.find((d) => d.sentAt === e.sentAt && d.target === e.target)?.status }));
  const errors: Record<string, number> = {};
  const health = new Map<string, { ok: number; statuses: Set<string>; errors: Set<string> }>();
  for (const r of runs) for (const h of r.health ?? []) {
    const x = health.get(h.sourceId) ?? { ok: 0, statuses: new Set<string>(), errors: new Set<string>() };
    if (h.ok) x.ok++;
    x.statuses.add(h.status);
    if (h.error) { x.errors.add(h.error); errors[h.error.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>').slice(0, 140)] = (errors[h.error.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>').slice(0, 140)] ?? 0) + 1; }
    health.set(h.sourceId, x);
  }
  const requestedSources = new Set(sent.filter((e) => e.hop === 0 && !isRobots(e)).map((e) => feedOf(e.url)?.s.id).filter(Boolean));
  const collected = [...health].filter(([, x]) => x.ok > 0).map(([id]) => id);
  const neverOk = [...health].filter(([, x]) => x.ok === 0).map(([id, x]) => ({ id, statuses: [...x.statuses], errors: [...x.errors] }));
  // Undated items: the first-seen time each published version gave them must never change.
  const history = existsSync(join(P.site, 'history')) ? readdirSync(join(P.site, 'history')).sort() : [];
  const firstSeen = new Map<string, Set<string>>();
  const versions = new Map<string, number>();
  const freshness: { version: string; generatedAt: string; newestItemAgeMin: number; medianSourceNewestAgeMin: number }[] = [];
  for (const h of history) {
    const w = JSON.parse(readFileSync(join(P.site, 'history', h, 'snapshot.json'), 'utf8')) as WireSnapshot;
    for (const a of w.articles) {
      if (a.p !== null) continue;
      firstSeen.set(a.i, new Set([...(firstSeen.get(a.i) ?? []), a.f!]));
      versions.set(a.i, (versions.get(a.i) ?? 0) + 1);
    }
    const gen = Date.parse(w.generatedAt);
    const newestBySource = new Map<string, number>();
    for (const a of w.articles) { const t = Date.parse(a.p ?? a.f ?? w.generatedAt); newestBySource.set(a.s, Math.max(newestBySource.get(a.s) ?? 0, t)); }
    const ages = [...newestBySource.values()].map((t) => (gen - t) / 60_000).sort((a, b) => a - b);
    freshness.push({ version: h, generatedAt: w.generatedAt, newestItemAgeMin: Math.round(ages[0] ?? NaN), medianSourceNewestAgeMin: Math.round(ages[Math.floor(ages.length / 2)] ?? NaN) });
  }
  const multi = [...firstSeen.entries()];
  return {
    runs: runs.map((r) => ({ run: r.run, startedAt: r.startedAt, status: r.status, published: r.published, reasons: r.reasons.slice(0, 2), notes: r.notes, traffic: r.traffic, wallMs: r.wallMs, cpuMs: r.cpuUserMs + r.cpuSystemMs, maxRssMb: Math.round(r.maxRssKb / 1024), stateKb: Math.round(r.stateBytes / 1024), snapshotKb: r.snapshotBytes ? Math.round(r.snapshotBytes / 1024) : undefined, rssKb: r.rssBytes ? Math.round(r.rssBytes / 1024) : undefined, articles: r.articles, undated: r.undated, nonEnglish: r.nonEnglish, perspectives: r.perspectives, trending: r.trending, multiSourceStories: r.multiSourceStories, sourcesOk: (r.health ?? []).filter((h) => h.ok).length, currentSnapshotSha: r.currentSnapshotSha })),
    totals: { requests: sent.length, feedRequests: sent.filter((e) => e.hop === 0 && !isRobots(e)).length, robotsRequests: sent.filter((e) => e.hop === 0 && isRobots(e)).length, redirectHops: sent.filter((e) => e.hop > 0).length, bytes: runs.reduce((n, r) => n + ((r.traffic as { bytes?: number } | undefined)?.bytes ?? 0), 0) },
    sources: { cleared: sources.length, requested: requestedSources.size, collected: collected.length, neverAnswering: neverOk },
    perHost, intervals, crawlDelays: delays, redirects, errors,
    undated: { items: multi.length, inSeveralVersions: multi.filter(([id]) => (versions.get(id) ?? 0) > 1).length, firstSeenChanged: multi.filter(([, s]) => s.size > 1).map(([id, s]) => ({ id, values: [...s] })) },
    freshness,
    statuses: done.reduce<Record<string, number>>((m, e) => { const k = String(e.status); m[k] = (m[k] ?? 0) + 1; return m; }, {}),
  };
}

// --- Smoke test ------------------------------------------------------------------------

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(P.log, line + '\n');
}

function child(run: number, extraEnv: Record<string, string>, killAfterMs?: number): Promise<number | null> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [import.meta.filename, 'run', '--out', out, '--run', String(run), '--registry', registryPath], { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => appendFileSync(P.log, String(d)));
    p.stderr.on('data', (d) => appendFileSync(P.log, String(d)));
    let timer: NodeJS.Timeout | undefined;
    if (killAfterMs !== undefined) timer = setTimeout(() => { log(`run ${run}: killing the process after ${killAfterMs} ms (crash drill)`); p.kill('SIGKILL'); }, killAfterMs);
    p.on('exit', (code) => { if (timer) clearTimeout(timer); res(code); });
  });
}

async function smoke(): Promise<void> {
  mkdirSync(out, { recursive: true });
  if (existsSync(P.ledger) || existsSync(P.state)) throw new Error(`${out} is not empty; use a new folder`);
  const every = Number(opt('--every', '15')) * 60_000;
  const t0 = Date.now();
  // The script: normal; immediate restart (refused); drill (publish refused, last good kept);
  // normal; killed mid-run; immediate restart (refused); normal (must honor the killed run's reservations).
  const plan: { at: number; env?: Record<string, string>; kill?: number; note: string }[] = [
    { at: 0, note: 'first run from empty state' },
    { at: 60_000, note: 'restart one minute later (must be refused before any request)' },
    { at: every, env: { SIGNAL_MIN_ARTICLES: '5000' }, note: 'drill: publish refused, the last good files must stay' },
    { at: 2 * every, note: 'normal run' },
    { at: 3 * every, kill: 4000, note: 'crash drill: killed 4 s in' },
    { at: 3 * every + 60_000, note: 'restart after the crash (must be refused before any request)' },
    { at: 4 * every, note: 'normal run after the crash (must honor its reservations)' },
  ];
  writeFileSync(join(out, 'plan.json'), JSON.stringify({ startedAt: new Date(t0).toISOString(), everyMs: every, plan }, null, 1));
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    const wait = t0 + step.at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const before = sha(join(P.site, 'current', 'snapshot.json'));
    log(`run ${i + 1}: ${step.note}`);
    const code = await child(i + 1, step.env ?? {}, step.kill);
    if (step.kill !== undefined) {
      appendFileSync(P.runs, JSON.stringify({ run: i + 1, startedAt: new Date(t0 + step.at).toISOString(), finishedAt: new Date().toISOString(), status: 'killed', reasons: ['killed by the crash drill'], published: false, notes: [], wallMs: step.kill, cpuUserMs: 0, cpuSystemMs: 0, maxRssKb: 0, stateBytes: statSync(P.state).size, env: step.env ?? {} }) + '\n');
    } else if (code !== 0) log(`run ${i + 1}: exited with code ${code}`);
    const after = sha(join(P.site, 'current', 'snapshot.json'));
    const last = readJsonl<RunLine>(P.runs).at(-1);
    if (last && !last.published && before !== after) { log(`VIOLATION last known good: run ${i + 1} did not publish but current files changed`); process.exit(2); }
    const v = audit();
    if (v.length > 0) {
      log(`STOPPED: ${v.length} policy violation(s) after run ${i + 1}`);
      for (const x of v.slice(0, 50)) log(`VIOLATION ${x.rule}: ${x.detail}`);
      writeFileSync(join(out, 'violations.json'), JSON.stringify(v, null, 1));
      process.exit(2);
    }
    log(`run ${i + 1}: audit clean (${readJsonl<LedgerLine>(P.ledger).filter((e) => e.phase === 'sent').length} requests so far)`);
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report(), null, 1));
  log('smoke test complete; report.json written');
}

// Only when run as a program: importing this file (the audit tests do) must never start a collection.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  if (cmd === 'run') await runOnce();
  else if (cmd === 'audit') { const v = audit(); console.log(JSON.stringify(v, null, 1)); if (v.length > 0) process.exit(2); }
  else if (cmd === 'report') console.log(JSON.stringify(report(), null, 1));
  else if (cmd === 'smoke') await smoke();
  else { console.error('usage: node tools/collect-local.ts run|audit|report|smoke --out <dir>'); process.exit(1); }
}
