// robots.txt evaluation per RFC 9309: pick the group for our product token (else "*"),
// then the longest matching rule wins, and Allow wins a tie. "*" matches any run of
// characters and a trailing "$" anchors the end.
//
// The gate at the bottom of this file is the only way the collector and the validator decide
// whether a publisher URL may be requested: robots.txt for the URL's origin is read and
// evaluated first, every time, before the URL itself is requested.
import { retryable, type Fetcher, type FetchOutcome, type FetchPolicy } from './fetch.ts';

export interface RobotsRule { allow: boolean; pattern: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[]; crawlDelay?: number }

export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (val) current.rules.push({ allow: key === 'allow', pattern: val });
      else if (key === 'disallow') current.rules.push({ allow: true, pattern: '' }); // "Disallow:" = allow all
    } else if (key === 'crawl-delay') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return groups;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, (c) => String.fromCharCode(92) + c))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export interface RobotsVerdict { allowed: boolean; matched?: RobotsRule; crawlDelay?: number }

export function robotsAllows(groups: RobotsGroup[], productToken: string, pathAndQuery: string): RobotsVerdict {
  const token = productToken.toLowerCase();
  let group = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  group ??= groups.find((g) => g.agents.includes('*'));
  if (!group) return { allowed: true };
  let best: RobotsRule | undefined;
  for (const r of group.rules) {
    if (r.pattern === '') continue;
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return { allowed: best ? best.allow : true, matched: best, crawlDelay: group.crawlDelay };
}

// --- The gate ---------------------------------------------------------------------------

/** What one robots.txt request established for an origin (RFC 9309 section 2.3.1). */
export type RobotsPolicy =
  /** 2xx: the file's rules apply (a file with no matching group restricts nothing). */
  | { kind: 'rules'; status: number; groups: RobotsGroup[] }
  /** 4xx other than a rate limit: "unavailable", so the site sets no restrictions (2.3.1.3). */
  | { kind: 'none'; status: number }
  /** Rate limits, 5xx, network errors and policy refusals: "unreachable", so complete disallow (2.3.1.4). */
  | { kind: 'unreachable'; reason: string; deferred?: boolean };

/** Rate-limit answers say "not now", not "no robots.txt": 429, and 419 as Hacker News sends it. */
const RATE_LIMITED = new Set([419, 429]);

export function robotsPolicyFrom(r: FetchOutcome): RobotsPolicy {
  if (r.ok && !r.notModified) return { kind: 'rules', status: r.status, groups: parseRobots(r.body) };
  if (r.status >= 400 && r.status < 500 && !RATE_LIMITED.has(r.status)) return { kind: 'none', status: r.status };
  return { kind: 'unreachable', reason: r.error ?? `HTTP ${r.status}` };
}

/** RFC 9309 section 2.4: a cached robots.txt should not be used for more than 24 hours. */
export const ROBOTS_MAX_AGE_MS = 24 * 3600_000;
/** RFC 9309 section 2.5 asks parsers to read at least 500 KiB; anything after this is ignored. */
export const ROBOTS_MAX_BYTES = 512 * 1024;

/** A robots.txt answer kept between runs. Unreachable answers are never kept. */
export interface RobotsCacheEntry { fetchedAt: string; policy: Exclude<RobotsPolicy, { kind: 'unreachable' }> }

export interface RobotsVerdictForUrl {
  allowed: boolean;
  /** Which robots.txt answer decided it. */
  basis: RobotsPolicy['kind'];
  /** The matching rule, as "Allow: /x" or "Disallow: /x". */
  rule?: string;
  /** Why the URL may not be requested (set whenever allowed is false). */
  reason?: string;
}

export interface RobotsGate {
  /** Reads robots.txt for the URL's origin (once per run, or from a fresh cache) and evaluates it. Never throws. */
  check(url: string, userAgent: string): Promise<RobotsVerdictForUrl>;
  /**
   * Call right before each request to the URL (after check). Honors the origin's Crawl-delay:
   * reserves the next permitted moment, waits for it, and resolves to null; or, when the wait
   * would be longer than allowed, resolves to a "skipped:" reason and the request must not be made.
   */
  pace(url: string, userAgent: string): Promise<string | null>;
  readonly stats: { requests: number; bytes: number; refused: number; deferred: number };
}

/** Longest Crawl-delay wait the collector accepts inside one run; a longer delay defers the request. */
export const CRAWL_DELAY_MAX_WAIT_MS = 30_000;
/** Added to every Crawl-delay, so the gap between two requests is never shorter than asked. */
export const CRAWL_DELAY_MARGIN_MS = 1000;

export interface RobotsGateOptions {
  now: Date;
  /** Product token matched against User-agent lines (shared/identity.ts ROBOTS_TOKEN). */
  token: string;
  /** Answers kept between runs; read when fresh, updated after each request. */
  cache?: Map<string, RobotsCacheEntry>;
  /** Attempts for a robots.txt request that fails with a network or server error. */
  attempts?: number;
  /** Longest Crawl-delay wait accepted (default CRAWL_DELAY_MAX_WAIT_MS). */
  maxWaitMs?: number;
  /**
   * Per origin, the latest request made or reserved (ms, same clock as `clock`). Pass the saved
   * times so Crawl-delay holds across runs and restarts; updated in place.
   */
  hostTimes?: Map<string, number>;
  /** Test seams for pacing. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The Crawl-delay (seconds) that applies to our token, or 0. */
export function crawlDelayOf(p: RobotsPolicy | RobotsCacheEntry['policy'] | undefined, token: string): number {
  return p?.kind === 'rules' ? (robotsAllows(p.groups, token, '/').crawlDelay ?? 0) : 0;
}

export function createRobotsGate(fetcher: Fetcher, policy: FetchPolicy, o: RobotsGateOptions): RobotsGate {
  const stats = { requests: 0, bytes: 0, refused: 0, deferred: 0 };
  const inRun = new Map<string, Promise<RobotsPolicy>>();
  const robotsFetchPolicy: FetchPolicy = { ...policy, maxBytes: Math.min(policy.maxBytes, ROBOTS_MAX_BYTES) };
  const attempts = Math.max(1, o.attempts ?? 1);
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const maxWait = o.maxWaitMs ?? CRAWL_DELAY_MAX_WAIT_MS;
  /** Per origin, the moment of the latest request made or reserved (robots.txt included). */
  const lastAt = o.hostTimes ?? new Map<string, number>();
  /**
   * Reserves the next moment a request to the origin may be sent, waits for it and returns null;
   * or returns the delay in seconds when the wait would be longer than a run may wait.
   */
  const reserve = async (origin: string, delaySec: number): Promise<number | null> => {
    const now = clock();
    const prev = lastAt.get(origin);
    const slot = prev === undefined ? now : Math.max(now, prev + (delaySec > 0 ? delaySec * 1000 + CRAWL_DELAY_MARGIN_MS : 0));
    if (slot - now > maxWait) return delaySec;
    lastAt.set(origin, slot);
    if (slot > now) await sleep(slot - now);
    return null;
  };

  const policyFor = (origin: string, userAgent: string): Promise<RobotsPolicy> => {
    const known = inRun.get(origin);
    if (known) return known;
    const cached = o.cache?.get(origin);
    const age = cached ? o.now.getTime() - Date.parse(cached.fetchedAt) : NaN;
    const p = cached && age >= 0 && age < ROBOTS_MAX_AGE_MS
      ? Promise.resolve<RobotsPolicy>(cached.policy)
      : (async (): Promise<RobotsPolicy> => {
        // Re-reading an expired robots.txt is itself a request: it waits out the Crawl-delay the
        // previous copy asked for (and any reservation left by an unfinished run).
        const waitSec = await reserve(origin, crawlDelayOf(cached?.policy, o.token));
        if (waitSec !== null) {
          stats.deferred++;
          return { kind: 'unreachable', deferred: true, reason: `not re-read yet: the last request to ${origin} was too recent (Crawl-delay ${waitSec} s)` };
        }
        let r: FetchOutcome | undefined;
        for (let i = 0; i < attempts; i++) {
          if (i > 0 && (await reserve(origin, crawlDelayOf(cached?.policy, o.token))) !== null) break;
          stats.requests++;
          try {
            r = await fetcher(origin + '/robots.txt', robotsFetchPolicy, { userAgent, allowTruncate: true });
          } catch (e) {
            r = { url: origin + '/robots.txt', finalUrl: origin + '/robots.txt', status: 0, ok: false, notModified: false, body: '', bytes: 0, ms: 0, error: e instanceof Error ? e.message : 'fetch failed' };
          }
          stats.bytes += r.bytes;
          lastAt.set(origin, clock());
          if (!retryable(r)) break;
        }
        const found = robotsPolicyFrom(r!);
        if (found.kind !== 'unreachable') o.cache?.set(origin, { fetchedAt: o.now.toISOString(), policy: found });
        return found;
      })();
    inRun.set(origin, p);
    return p;
  };

  const refuse = (v: RobotsVerdictForUrl): RobotsVerdictForUrl => { stats.refused++; return v; };

  return {
    stats,
    async check(url, userAgent) {
      let u: URL;
      try { u = new URL(url); } catch { return refuse({ allowed: false, basis: 'unreachable', reason: 'robots.txt: not a valid URL' }); }
      const found = await policyFor(u.origin, userAgent);
      if (found.kind === 'unreachable' && found.deferred) {
        return refuse({ allowed: false, basis: 'unreachable', reason: `skipped: robots.txt ${found.reason}; deferred to a later run` });
      }
      if (found.kind === 'unreachable') {
        return refuse({ allowed: false, basis: 'unreachable', reason: `robots.txt unreachable (${found.reason}); treated as disallow-all (RFC 9309 2.3.1.4)` });
      }
      if (found.kind === 'none') return { allowed: true, basis: 'none' };
      const target = u.pathname + u.search;
      const v = robotsAllows(found.groups, o.token, target);
      const rule = v.matched ? (v.matched.allow ? 'Allow: ' : 'Disallow: ') + v.matched.pattern : undefined;
      if (!v.allowed) return refuse({ allowed: false, basis: 'rules', rule, reason: `robots.txt disallows ${target} (${rule})` });
      return { allowed: true, basis: 'rules', rule };
    },
    async pace(url, userAgent) {
      const origin = new URL(url).origin;
      const found = await policyFor(origin, userAgent);
      // The group that applies to us is the same for every path, so any path finds its delay.
      const delaySec = crawlDelayOf(found, o.token);
      if ((await reserve(origin, delaySec)) === null) return null;
      stats.deferred++;
      return delaySec > 0
        ? `skipped: robots.txt Crawl-delay is ${delaySec} s; deferred to a later run`
        : `skipped: the last request to ${origin} was reserved by a run that did not finish; deferred to a later run`;
    },
  };
}
