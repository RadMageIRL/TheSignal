// Production storage on Vercel Blob. Two stores:
// - private: the collector state (with a conditional write that doubles as the run lock), the
//   control file (the kill switch), the store identity, earlier snapshots, and operations logs;
// - public: the files the site and RSS readers fetch (current snapshot and feeds).
// Each store is reached with a read-write token or, on Vercel, with the project's OIDC
// credentials and the store id.
import { BlobPreconditionFailedError, del, get, list, put } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { decodeState, emptyState, type CollectorState, type StateLoad, type StateStore } from './state.ts';
import { JSON_CONTENT_TYPE, type PublishedFile, type SiteStore } from './storage.ts';

export interface BlobAuth { token?: string; storeId?: string }

/** Auth for the store whose env prefix is given: <P>_BLOB_READ_WRITE_TOKEN, else <P>_BLOB_STORE_ID (OIDC). */
export function blobAuth(env: Record<string, string | undefined>, prefix: 'PUBLIC' | 'PRIVATE'): BlobAuth | null {
  const token = env[`${prefix}_BLOB_READ_WRITE_TOKEN`];
  if (token) return { token };
  const storeId = env[`${prefix}_BLOB_STORE_ID`];
  return storeId ? { storeId } : null;
}

export const PATHS = {
  state: 'state/state.json',
  control: 'control.json',
  identity: 'identity.json',
  manifest: 'site/manifest.json',
  history: 'history/',
  ops: 'ops/',
} as const;

/** Reads a private blob, bypassing the CDN cache so an overwrite or a deletion is seen at once. */
export async function readPrivate(pathname: string, auth: BlobAuth): Promise<{ text: string; etag: string } | null> {
  const r = await get(pathname, { access: 'private', useCache: false, ...auth });
  if (!r || r.statusCode !== 200) return null;
  return { text: await new Response(r.stream).text(), etag: r.blob.etag };
}

export class StateConflictError extends Error {
  constructor() { super('another run changed the collector state'); }
}

/**
 * The collector state in the private store. Every save is conditional on the version this
 * instance last read or wrote, so of two overlapping runs only the first can save its
 * reservations; the second stops before it requests anything.
 */
export class BlobStateStore implements StateStore {
  readonly auth: BlobAuth;
  private etag: string | null = null;
  constructor(auth: BlobAuth) { this.auth = auth; }

  async load(now: Date): Promise<StateLoad> {
    let r: { text: string; etag: string } | null;
    try { r = await readPrivate(PATHS.state, this.auth); } catch (e) { return { problem: `cannot read the state (${e instanceof Error ? e.message : 'error'})` }; }
    if (!r) { this.etag = null; return { state: emptyState(now), fresh: true }; }
    this.etag = r.etag;
    return decodeState(r.text);
  }

  async save(state: CollectorState): Promise<void> {
    try {
      const res = await put(PATHS.state, JSON.stringify(state), {
        access: 'private', contentType: JSON_CONTENT_TYPE, addRandomSuffix: false, cacheControlMaxAge: 60,
        // First save creates the file and fails if another run created it first.
        ...(this.etag ? { ifMatch: this.etag } : { allowOverwrite: false }),
        ...this.auth,
      });
      this.etag = res.etag;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) throw new StateConflictError();
      if (!this.etag && e instanceof Error && /already exists/i.test(e.message)) throw new StateConflictError();
      throw e;
    }
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Browser and CDN cache lifetimes (seconds) for the published files. */
export const CACHE_SECONDS = { snapshot: 60, rss: 300 } as const;

/**
 * Publishes to the public store under `current/`, writing only files whose content changed (an
 * unchanged feed keeps its ETag, so readers get 304), and keeps each published snapshot in the
 * private store's history (feeds are rebuilt from a snapshot on rollback).
 */
export class BlobSiteStore implements SiteStore {
  readonly pub: BlobAuth;
  readonly priv: BlobAuth;
  readonly keep: number;
  /** Counted for the operations log. */
  readonly stats = { written: 0, unchanged: 0, historyPruned: 0 };
  constructor(pub: BlobAuth, priv: BlobAuth, keep: number) { this.pub = pub; this.priv = priv; this.keep = keep; }

  async publish(files: PublishedFile[], stamp: string): Promise<void> {
    const prev = await readPrivate(PATHS.manifest, this.priv);
    const manifest: Record<string, string> = prev ? JSON.parse(prev.text) as Record<string, string> : {};
    // Feeds first, the snapshot last: the page reads the snapshot, so it changes only once the feeds it lists exist.
    const ordered = [...files.filter((f) => f.path !== 'snapshot.json'), ...files.filter((f) => f.path === 'snapshot.json')];
    for (const f of ordered) {
      const h = sha(f.body);
      if (manifest[f.path] === h) { this.stats.unchanged++; continue; }
      await put(`current/${f.path}`, f.body, {
        access: 'public', contentType: f.contentType, addRandomSuffix: false, allowOverwrite: true,
        cacheControlMaxAge: f.path === 'snapshot.json' ? CACHE_SECONDS.snapshot : CACHE_SECONDS.rss,
        ...this.pub,
      });
      manifest[f.path] = h;
      this.stats.written++;
    }
    const snap = files.find((f) => f.path === 'snapshot.json');
    if (snap) {
      await put(`${PATHS.history}${stamp}/snapshot.json`, snap.body, { access: 'private', contentType: JSON_CONTENT_TYPE, addRandomSuffix: false, allowOverwrite: true, ...this.priv });
    }
    await put(PATHS.manifest, JSON.stringify(manifest), { access: 'private', contentType: JSON_CONTENT_TYPE, addRandomSuffix: false, allowOverwrite: true, ...this.priv });
    const old = await historyStamps(this.priv);
    const drop = old.slice(0, Math.max(0, old.length - this.keep));
    if (drop.length > 0) {
      await del(drop.map((s) => `${PATHS.history}${s}/snapshot.json`), { ...this.priv });
      this.stats.historyPruned += drop.length;
    }
  }
}

/** History versions in the private store, oldest first. */
export async function historyStamps(auth: BlobAuth): Promise<string[]> {
  const stamps: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: PATHS.history, cursor, limit: 1000, ...auth });
    for (const b of page.blobs) {
      const m = /^history\/([0-9TZ]+)\/snapshot\.json$/.exec(b.pathname);
      if (m) stamps.push(m[1]!);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return stamps.sort();
}

/** The kill switch: collection runs only while control.json exists and says {"collect": "on"}. */
export interface Control { collect: 'on'; drill?: 'keep-last-good' }

export async function readControl(auth: BlobAuth): Promise<{ control: Control; stop?: undefined } | { stop: string }> {
  let r: { text: string } | null;
  try { r = await readPrivate(PATHS.control, auth); } catch { return { stop: 'the control file could not be read' }; }
  if (!r) return { stop: 'no control file: collection is switched off' };
  let x: unknown;
  try { x = JSON.parse(r.text); } catch { return { stop: 'the control file is not valid JSON' }; }
  if (typeof x !== 'object' || x === null || (x as { collect?: unknown }).collect !== 'on') return { stop: 'the control file does not say "collect": "on"' };
  const drill = (x as { drill?: unknown }).drill;
  return { control: { collect: 'on', ...(drill === 'keep-last-good' ? { drill } : {}) } };
}

/** The private store must say which deployment it belongs to, so a misconfigured project cannot write to another's store. */
export interface StoreIdentity { deployment: string; project: string }

export async function identityProblem(auth: BlobAuth, expected: StoreIdentity): Promise<string | null> {
  let r: { text: string } | null;
  try { r = await readPrivate(PATHS.identity, auth); } catch { return 'the store identity could not be read'; }
  if (!r) return 'the private store has no identity.json';
  try {
    const x = JSON.parse(r.text) as Partial<StoreIdentity>;
    if (x.deployment !== expected.deployment || x.project !== expected.project) {
      return `the private store belongs to ${String(x.project)}/${String(x.deployment)}, not ${expected.project}/${expected.deployment}`;
    }
  } catch { return 'identity.json is not valid JSON'; }
  return null;
}

export async function writeOpsLog(auth: BlobAuth, stamp: string, entry: unknown): Promise<void> {
  await put(`${PATHS.ops}${stamp.slice(0, 8)}/${stamp}.json`, JSON.stringify(entry), {
    access: 'private', contentType: JSON_CONTENT_TYPE, addRandomSuffix: false, allowOverwrite: true, ...auth,
  });
}

/** Operations logs are kept this many days. */
export const OPS_KEEP_DAYS = 14;

/** Deletes operations logs from days before the retention window. Returns how many were deleted. */
export async function pruneOpsLogs(auth: BlobAuth, now: Date, keepDays = OPS_KEEP_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 24 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  const old: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: PATHS.ops, cursor, limit: 1000, ...auth });
    for (const b of page.blobs) {
      const day = /^ops\/(\d{8})\//.exec(b.pathname)?.[1];
      if (day && day < cutoff) old.push(b.pathname);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < old.length; i += 100) await del(old.slice(i, i + 100), { ...auth });
  return old.length;
}
