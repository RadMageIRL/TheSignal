// One scheduled production run, as the cron endpoint (api/collect.ts) performs it. Every check
// that can stop a run happens before the first publisher request:
//   1. the caller presents CRON_SECRET (checked by the endpoint);
//   2. SIGNAL_INGEST is "on" and this is the production deployment named in SIGNAL_DEPLOYMENT;
//   3. the private store's identity.json names this project and deployment;
//   4. control.json exists and says {"collect": "on"} (deleting it is the kill switch, no redeploy);
//   5. the saved state is readable, the previous run started at least 10 minutes ago, and this
//      run's reservations were saved first (a conditional write, so overlapping runs cannot both go).
// Only a run that passes every publish check replaces the published files; every run writes an
// operations log.
import type { SourceEntry } from '../shared/types.ts';
import type { RequestEvent } from './fetch.ts';
import { readControls } from './controls.ts';
import { runCollection, type RunDeps, type RunOutcome } from './publish.ts';
import { deliver, stampOf } from './storage.ts';
import { BlobSiteStore, BlobStateStore, blobAuth, identityProblem, pruneOpsLogs, readControl, writeOpsLog, type BlobAuth } from './blob.ts';
import { LIMITS } from './controls.ts';

export const PROJECT = 'the-signal';

export interface ProductionResult {
  status: RunOutcome['status'] | 'refused' | 'stopped';
  published: boolean;
  reasons: string[];
}

export interface ProductionDeps extends Pick<RunDeps, 'fetcher' | 'clock' | 'sleep'> {
  now?: Date;
}

/** A short public summary only: details go to the private operations log. */
export async function productionRun(env: Record<string, string | undefined>, registry: SourceEntry[], deps: ProductionDeps = {}): Promise<ProductionResult> {
  const now = deps.now ?? new Date();
  const stamp = stampOf(now);
  const { controls, warnings } = readControls(env);
  if (!controls.ingest) return { status: 'suspended', published: false, reasons: ['SIGNAL_INGEST is not "on"'] };
  if (env.SIGNAL_DEPLOYMENT !== 'production' || env.VERCEL_ENV !== 'production') {
    return { status: 'refused', published: false, reasons: ['not the production deployment'] };
  }
  const priv = blobAuth(env, 'PRIVATE');
  const pub = blobAuth(env, 'PUBLIC');
  if (!priv || !pub) return { status: 'refused', published: false, reasons: ['a Blob store is not configured'] };

  const idp = await identityProblem(priv, { deployment: 'production', project: PROJECT });
  if (idp) return { status: 'refused', published: false, reasons: [idp] };
  const ctl = await readControl(priv);
  if (ctl.stop !== undefined) {
    await safeLog(priv, stamp, { at: now.toISOString(), status: 'stopped', reasons: [ctl.stop] });
    return { status: 'stopped', published: false, reasons: [ctl.stop] };
  }
  // The recovery drill: collect as usual but refuse to publish, proving the last good files stay.
  if (ctl.control.drill === 'keep-last-good') controls.minArticles = LIMITS.minArticles[2];

  const ledger: RequestEvent[] = [];
  const outcome = await runCollection(registry, controls, now, {
    ...deps,
    store: new BlobStateStore(priv),
    observe: (e) => { if (e.phase === 'done') ledger.push(e); },
  });
  const site = new BlobSiteStore(pub, priv, controls.historyKeep);
  let published = false;
  const reasons = [...outcome.reasons];
  try {
    published = await deliver(outcome, site, now);
  } catch (e) {
    reasons.push(`publishing failed (${e instanceof Error ? e.message : 'error'}); the previous files stay in place`);
  }
  await safeLog(priv, stamp, {
    at: now.toISOString(), status: outcome.status, published, reasons, warnings, drill: ctl.control.drill ?? null,
    report: 'report' in outcome ? outcome.report : undefined, site: site.stats,
    requests: ledger.map((e) => ({ t: e.target, s: e.status, ms: e.ms, at: e.sentAt, hop: e.hop })),
  });
  // Once a day (the first run after midnight UTC), drop operations logs older than the retention window.
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 15) {
    try { await pruneOpsLogs(priv, now); } catch { /* retried tomorrow */ }
  }
  return { status: outcome.status, published, reasons: reasons.slice(0, 3) };
}

async function safeLog(auth: BlobAuth, stamp: string, entry: unknown): Promise<void> {
  try { await writeOpsLog(auth, stamp, entry); } catch { /* a lost log line must not fail the run */ }
}
