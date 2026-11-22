// Collector state kept between runs: when each feed was last requested and may be requested
// again, its HTTP validators and latest items, per-origin request times and cool-downs, the
// robots.txt answers, and when each item was first seen.
//
// The collector saves this state twice per run. Before its first request it saves a copy in
// which every feed and origin it may contact is marked as contacted at the latest moment the run
// could reach it; when the run ends it saves the real times. So a crash, a timeout or a restart
// can never lead to a request earlier than a feed's interval or an origin's Crawl-delay allows.
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { Article } from '../shared/types.ts';
import { ROBOTS_MAX_AGE_MS, type RobotsCacheEntry } from './robots.ts';

export const STATE_VERSION = 1;

export interface FeedState {
  /** When the latest request for this feed was sent (in a saved reservation: the latest moment it could be sent). */
  lastRequestAt?: string;
  lastSuccessAt?: string;
  /** Earliest moment the next request may be sent, from backoff or Retry-After (the interval is applied separately). */
  nextDueAt?: string;
  /** Consecutive failed attempts. */
  failures: number;
  etag?: string;
  lastModified?: string;
  /** "ok", "not-modified" or the latest error. */
  lastOutcome?: string;
  /** Items from the latest successful response, shown while the feed is not due or answers 304. */
  items: Article[];
}

export interface HostState {
  /** Latest request to this origin (robots.txt included), or a reservation. */
  lastRequestAt?: string;
  /** Set after HTTP 419 or 429: nothing is requested from this origin before then. */
  coolDownUntil?: string;
  coolDownReason?: string;
}

export interface CollectorState {
  version: typeof STATE_VERSION;
  savedAt: string;
  lastRunStartedAt?: string;
  /** Set in the copy saved before a run's first request; a loaded state with it set comes from a run that did not finish. */
  inFlight?: { startedAt: string; until: string };
  feeds: Record<string, FeedState>;
  hosts: Record<string, HostState>;
  robots: Record<string, RobotsCacheEntry>;
  /** Per article id: when it was first (f) and most recently (l) seen in a feed response. */
  seen: Record<string, { f: string; l: string }>;
}

/** Longest backoff after repeated failures. */
export const BACKOFF_MAX_MS = 6 * 3600_000;
/** An origin that answers 419 or 429 is left alone this long (longer if its Retry-After says so). */
export const COOL_DOWN_MS = 24 * 3600_000;
export const RETRY_AFTER_MAX_MS = 7 * 24 * 3600_000;
/** A feed that falls due within this long is waited for inside the run instead of left to the next run. */
export const DUE_WAIT_MS = 30_000;
/** A feed's items stay on the page this long past its interval after its last success. */
export const CARRY_MS = 6 * 3600_000;
/** First-seen times are kept this long after an item was last seen (longer than any section's window). */
export const SEEN_KEEP_MS = 15 * 24 * 3600_000;
export const MAX_STORED_ITEMS = 100;
/** A feed date later than the first sighting by more than this is not believed. */
export const DATE_SKEW_MS = 15 * 60_000;

export function emptyState(now: Date): CollectorState {
  return { version: STATE_VERSION, savedAt: now.toISOString(), feeds: {}, hosts: {}, robots: {}, seen: {} };
}

/** Feeds are keyed by source and registry URL (templates unfilled), so a daily URL keeps one schedule. */
export function feedKey(sourceId: string, registryUrl: string): string {
  return `${sourceId} ${registryUrl}`;
}

const ms = (iso: string | undefined): number => (iso === undefined ? -Infinity : Date.parse(iso));

/** Added to every interval, so two polls of a feed are never closer than its interval, measured at send time. */
export const INTERVAL_MARGIN_MS = 1000;

/** Earliest moment (ms) the feed may be requested: its interval after the last request, and any backoff. */
export function earliestRequest(fs: FeedState | undefined, intervalMinutes: number): number {
  if (!fs) return -Infinity;
  return Math.max(ms(fs.lastRequestAt) + intervalMinutes * 60_000 + INTERVAL_MARGIN_MS, ms(fs.nextDueAt));
}

/** Wait before the next attempt after `failures` consecutive failures: the interval, doubled per failure, capped. */
export function backoffMs(intervalMinutes: number, failures: number): number {
  const interval = intervalMinutes * 60_000;
  return Math.max(interval, Math.min(BACKOFF_MAX_MS, interval * 2 ** Math.min(failures, 20)));
}

/** Retry-After as milliseconds from now (seconds or an HTTP date), or null. */
export function retryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/**
 * The copy saved before a run's first request: each listed feed and origin is marked as contacted
 * at `until`, the latest moment this run could contact it.
 */
export function withReservations(state: CollectorState, feedKeys: Iterable<string>, origins: Iterable<string>, startedAt: Date, until: Date): CollectorState {
  const u = until.toISOString();
  const copy: CollectorState = { ...state, feeds: { ...state.feeds }, hosts: { ...state.hosts }, lastRunStartedAt: startedAt.toISOString(), inFlight: { startedAt: startedAt.toISOString(), until: u } };
  for (const k of feedKeys) copy.feeds[k] = { ...(copy.feeds[k] ?? { failures: 0, items: [] }), lastRequestAt: u };
  for (const o of origins) copy.hosts[o] = { ...copy.hosts[o], lastRequestAt: u };
  return copy;
}

/** Drops what can no longer matter: old first-seen records, expired robots answers, idle hosts, removed feeds. */
export function pruneState(state: CollectorState, liveFeeds: Set<string>, now: Date): void {
  const t = now.getTime();
  for (const [k, fs] of Object.entries(state.feeds)) {
    if (liveFeeds.has(k)) continue;
    // A feed no longer collected keeps its schedule for a week (in case it returns) but not its items.
    if (t - ms(fs.lastRequestAt) > 7 * 24 * 3600_000) delete state.feeds[k];
    else fs.items = [];
  }
  for (const [id, s] of Object.entries(state.seen)) if (t - Date.parse(s.l) > SEEN_KEEP_MS) delete state.seen[id];
  for (const [o, r] of Object.entries(state.robots)) if (t - Date.parse(r.fetchedAt) >= ROBOTS_MAX_AGE_MS) delete state.robots[o];
  for (const [o, h] of Object.entries(state.hosts)) {
    if (t - ms(h.lastRequestAt) > 24 * 3600_000 && !(ms(h.coolDownUntil) > t)) delete state.hosts[o];
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isIso = (x: unknown): boolean => typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x));
const optIso = (x: unknown): boolean => x === undefined || isIso(x);

/** Structural check of a loaded state. Any problem makes the collector refuse to run (fail closed). */
export function stateProblems(x: unknown): string[] {
  if (!isObj(x)) return ['not an object'];
  const out: string[] = [];
  if (x.version !== STATE_VERSION) out.push(`version ${String(x.version)} is not ${STATE_VERSION}`);
  if (!isIso(x.savedAt)) out.push('bad savedAt');
  if (!optIso(x.lastRunStartedAt)) out.push('bad lastRunStartedAt');
  if (x.inFlight !== undefined && (!isObj(x.inFlight) || !isIso(x.inFlight.startedAt) || !isIso(x.inFlight.until))) out.push('bad inFlight');
  for (const k of ['feeds', 'hosts', 'robots', 'seen'] as const) if (!isObj(x[k])) out.push(`bad ${k}`);
  if (out.length > 0) return out;
  for (const [k, f] of Object.entries(x.feeds as Record<string, unknown>)) {
    if (!isObj(f) || typeof f.failures !== 'number' || !Array.isArray(f.items)
      || !optIso(f.lastRequestAt) || !optIso(f.lastSuccessAt) || !optIso(f.nextDueAt)) out.push(`feed ${k}: malformed`);
  }
  for (const [k, h] of Object.entries(x.hosts as Record<string, unknown>)) {
    if (!isObj(h) || !optIso(h.lastRequestAt) || !optIso(h.coolDownUntil)) out.push(`host ${k}: malformed`);
  }
  for (const [k, r] of Object.entries(x.robots as Record<string, unknown>)) {
    if (!isObj(r) || !isIso(r.fetchedAt) || !isObj(r.policy)) out.push(`robots ${k}: malformed`);
  }
  for (const [k, s] of Object.entries(x.seen as Record<string, unknown>)) {
    if (!isObj(s) || !isIso(s.f) || !isIso(s.l)) { out.push(`seen ${k}: malformed`); break; }
  }
  return out.slice(0, 10);
}

export type StateLoad = { state: CollectorState; problem?: undefined; fresh: boolean } | { state?: undefined; problem: string };

/** Where the state lives: a file locally, a private store in production. */
export interface StateStore {
  /** A missing state is a first run (fresh: true); an unreadable or malformed one is a problem. */
  load(now: Date): Promise<StateLoad>;
  save(state: CollectorState): Promise<void>;
}

export function decodeState(text: string): StateLoad {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return { problem: 'not valid JSON' }; }
  const p = stateProblems(x);
  return p.length > 0 ? { problem: p.join('; ') } : { state: x as CollectorState, fresh: false };
}

export class FileStateStore implements StateStore {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  async load(now: Date): Promise<StateLoad> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState(now), fresh: true };
      return { problem: `cannot read ${this.path}` };
    }
    return decodeState(text);
  }

  async save(state: CollectorState): Promise<void> {
    // Write then rename, so a crash mid-write leaves the previous state intact.
    const tmp = this.path + '.tmp';
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, this.path);
  }
}
