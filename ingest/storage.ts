// Where published files go. A run hands over files only when its outcome is "publish"; every
// other outcome writes nothing, so the last good snapshot and feeds stay exactly as they were.
// Each publish also keeps a copy in history, so an earlier version can be restored.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunOutcome } from './publish.ts';

export const RSS_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export interface PublishedFile { path: string; body: string; contentType: string }

export interface SiteStore {
  /** Replaces the current files with these and keeps them in history under `stamp`. */
  publish(files: PublishedFile[], stamp: string): Promise<void>;
}

export function filesOf(outcome: Extract<RunOutcome, { status: 'publish' }>): PublishedFile[] {
  return [
    { path: 'snapshot.json', body: outcome.snapshotJson, contentType: JSON_CONTENT_TYPE },
    ...outcome.feeds.map((d) => ({ path: d.spec.path, body: d.xml, contentType: RSS_CONTENT_TYPE })),
  ];
}

/** History folder name for a run: its start time, sortable and safe in paths. */
export function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '').replace(/-/g, '');
}

/** Publishes a "publish" outcome; anything else leaves the store untouched. Returns whether it published. */
export async function deliver(outcome: RunOutcome, store: SiteStore, now: Date): Promise<boolean> {
  if (outcome.status !== 'publish') return false;
  await store.publish(filesOf(outcome), stampOf(now));
  return true;
}

const SAFE_PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** A folder on disk: `current/` holds the published files, `history/<stamp>/` earlier versions. */
export class DirSiteStore implements SiteStore {
  readonly dir: string;
  readonly keep: number;
  constructor(dir: string, keep: number) { this.dir = dir; this.keep = keep; }

  async publish(files: PublishedFile[], stamp: string): Promise<void> {
    for (const f of files) if (!SAFE_PATH.test(f.path)) throw new Error(`unsafe path ${f.path}`);
    const hist = join(this.dir, 'history', stamp);
    for (const f of files) {
      await mkdir(dirname(join(hist, f.path)), { recursive: true });
      await writeFile(join(hist, f.path), f.body);
    }
    // Each current file is replaced by a rename, so a reader never sees a half-written file.
    for (const f of files) {
      const target = join(this.dir, 'current', f.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target + '.tmp', f.body);
      await rename(target + '.tmp', target);
    }
    const all = (await readdir(join(this.dir, 'history'))).sort();
    for (const old of all.slice(0, Math.max(0, all.length - this.keep))) await rm(join(this.dir, 'history', old), { recursive: true, force: true });
  }
}
