// Read-only checkpoint for the first 48 hours after launch. Reads the private operations logs,
// runs the post-deploy checks against the live site, optionally reads Vercel usage with the CLI,
// compares everything with the launch baseline and says whether to act. Changes nothing.
//
//   PRIVATE_BLOB_READ_WRITE_TOKEN=... node tools/monitor.ts --base https://<site>/ [--hours 24]
//       [--api https://<project>.vercel.app/api/collect] [--usage] [--out local/monitor]
//
// --usage runs `vercel billing usage --group-by project --json` (read-only; needs a CLI login).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { SourceEntry } from '../shared/types.ts';
import { blobAuth } from '../ingest/blob.ts';
import { entriesSince, summarize } from './ops.ts';
import { siteGet, smokeChecks, type Check } from './smoke-prod.ts';

/** The launch plan's expectations, used as a baseline (not a guarantee). */
export const BASELINE = {
  feedRequestsPerDay: 3200,
  robotsRequestsPerDay: 80,
  bytesReadPerDay: 400e6,
  runsPerDay: 96,
  maxGapBetweenPublishesMin: 45,
  costPerDayUsd: 0.12,
} as const;

export interface Alert { level: 'stop' | 'watch'; what: string }

/** What a checkpoint should flag. "stop" means: switch collection off (ops.ts off), then investigate. */
export function evaluate(
  summary: ReturnType<typeof summarize>,
  checks: Check[],
  hours: number,
  costUsd: number | null,
  baseline = BASELINE,
): Alert[] {
  const out: Alert[] = [];
  const perDay = (n: number) => (n * 24) / Math.max(1, hours);
  for (const c of checks) if (!c.ok) out.push({ level: 'stop', what: `site check failed: ${c.name}${c.detail ? ` (${c.detail})` : ''}` });
  if (summary.runs === 0) out.push({ level: 'stop', what: 'no collection runs logged in the window' });
  if (summary.published === 0 && summary.runs > 0) out.push({ level: 'stop', what: 'no run published in the window' });
  if (summary.longestGapBetweenPublishesMin > baseline.maxGapBetweenPublishesMin) {
    out.push({ level: 'watch', what: `longest gap between publishes ${summary.longestGapBetweenPublishesMin} min (baseline ${baseline.maxGapBetweenPublishesMin})` });
  }
  const feed = perDay(summary.requests.feed);
  if (feed > 2 * baseline.feedRequestsPerDay) out.push({ level: 'stop', what: `publisher feed requests at ${Math.round(feed)} a day, over twice the baseline ${baseline.feedRequestsPerDay}` });
  const robots = perDay(summary.requests.robots);
  if (robots > 2 * baseline.robotsRequestsPerDay) out.push({ level: 'watch', what: `robots.txt requests at ${Math.round(robots)} a day (baseline ${baseline.robotsRequestsPerDay})` });
  const bytes = perDay(summary.bytesRead);
  if (bytes > 2 * baseline.bytesReadPerDay) out.push({ level: 'watch', what: `bytes read from publishers at ${Math.round(bytes / 1e6)} MB a day (baseline ${baseline.bytesReadPerDay / 1e6} MB)` });
  const runs = perDay(summary.runs);
  if (runs > 1.5 * baseline.runsPerDay) out.push({ level: 'watch', what: `${Math.round(runs)} runs a day (baseline ${baseline.runsPerDay}): duplicate cron deliveries?` });
  const failing = Object.entries(summary.failingSources).filter(([, f]) => f.runs >= Math.max(3, summary.runs / 2));
  if (failing.length > 0) out.push({ level: 'watch', what: `sources failing in most runs: ${failing.map(([id, f]) => `${id} (${f.last ?? 'no error text'})`).join('; ')}` });
  if (costUsd !== null && costUsd > 2 * perDayCost(baseline) * (hours / 24)) {
    out.push({ level: 'stop', what: `Vercel usage $${costUsd.toFixed(2)} in ${hours} h, over twice the baseline` });
  }
  return out;
}

const perDayCost = (b: typeof BASELINE) => b.costPerDayUsd;

/** The project's billed amount from `vercel billing usage --group-by project --json`, or null when unreadable. */
export function projectCost(json: unknown, project: string): number | null {
  const rows = Array.isArray(json) ? json : (json as { rows?: unknown[]; data?: unknown[] } | null)?.rows ?? (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(rows)) return null;
  let total = 0; let found = false;
  for (const r of rows as Record<string, unknown>[]) {
    const name = String(r.project ?? r.projectName ?? r.name ?? '');
    if (name !== project) continue;
    const v = Number(r.cost ?? r.amount ?? r.billedCost ?? r.total);
    if (Number.isFinite(v)) { total += v; found = true; }
  }
  return found ? total : null;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n: string, d?: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const base = opt('--base');
  const hours = Number(opt('--hours', '24'));
  const project = opt('--project', 'the-signal')!;
  if (!/^[a-z0-9-]{1,100}$/.test(project) || !Number.isFinite(hours) || hours <= 0 || hours > 720) { console.error('bad --project or --hours'); process.exit(1); }
  if (!base || !base.endsWith('/')) { console.error('usage: node tools/monitor.ts --base https://<site>/ [--hours 24] [--api <url>] [--usage]'); process.exit(1); }
  const priv = blobAuth(process.env, 'PRIVATE');
  if (!priv) { console.error('PRIVATE_BLOB_READ_WRITE_TOKEN is not set (read access to the operations logs)'); process.exit(1); }
  const registry = JSON.parse(readFileSync('registry/sources.json', 'utf8')) as SourceEntry[];
  const apiUrl = opt('--api');
  const summary = summarize(await entriesSince(priv, Date.now() - hours * 3600_000));
  const checks = await smokeChecks(base, { get: siteGet(base, apiUrl), registry, maxAgeMin: 45, apiUrl });
  let cost: number | null = null;
  let usage: unknown = null;
  if (args.includes('--usage')) {
    const r = spawnSync('npx', ['--yes', 'vercel@65.12.1', 'billing', 'usage', '--since', `${hours}h`, '--group-by', 'project', '--json'], { encoding: 'utf8', shell: true, env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' } });
    try { usage = JSON.parse(r.stdout); cost = projectCost(usage, project); } catch { usage = { error: (r.stderr || r.stdout).slice(0, 400) }; }
  }
  const alerts = evaluate(summary, checks, hours, cost);
  const report = { at: new Date().toISOString(), hours, base, summary, checks, usage, cost, alerts };
  const outDir = opt('--out', 'local/monitor')!;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `checkpoint-${report.at.replace(/[:.]/g, '')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(`runs ${summary.runs} (${JSON.stringify(summary.byStatus)}), published ${summary.published}, longest gap ${summary.longestGapBetweenPublishesMin} min`);
  console.log(`requests: feed ${summary.requests.feed}, robots ${summary.requests.robots}, 304 ${summary.requests.notModified}; bytes read ${Math.round(summary.bytesRead / 1e6)} MB`);
  console.log(`site checks: ${checks.filter((c) => c.ok).length} of ${checks.length} passed${cost !== null ? `; Vercel usage for ${project}: $${cost.toFixed(2)}` : ''}`);
  for (const a of alerts) console.log(`${a.level.toUpperCase()}: ${a.what}`);
  console.log(alerts.some((a) => a.level === 'stop') ? 'ACTION: run "node tools/ops.ts off", then investigate' : 'no action needed');
  console.log(`written ${file}`);
}
