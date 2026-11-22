// Read-only checkpoint for the first 48 hours after launch. Reads the private operations logs,
// runs the post-deploy checks against the live site, optionally reads Vercel usage with the CLI,
// compares everything with the launch baseline and says whether to act. Changes nothing.
//
//   PRIVATE_BLOB_READ_WRITE_TOKEN=... node tools/monitor.ts --base https://radmagelabs.com/signal/ [--hours 24]
//       [--origin https://<project>.vercel.app/signal/] [--api https://<project>.vercel.app/api/collect]
//       [--usage] [--out local/monitor]
//   node tools/monitor.ts --labs-baseline-out [--days 7]     (once, before launch)
//
// --usage runs `vercel billing usage --group-by project --json` (read-only; needs a CLI login) and reads
// both the-signal and the Labs project: every request to radmagelabs.com/signal/ is also a CDN request on
// Labs (the rewrite), so Labs is compared with its own pre-launch level from --labs-baseline-out.
// --origin also checks the project address, and whether Labs caches the rewritten files.
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
  // CDN requests the /signal/ rewrite adds to the Labs project. The launch plan's audience (10,000 visits and 50 feed
  // readers polling two feeds every 30 minutes, about 330,000 requests a month) is about 11,000 a day.
  labsRewriteRequestsPerDay: 11000,
} as const;

export interface Alert { level: 'stop' | 'watch'; what: string }

/** One project's line in the usage output: billed amount and CDN (edge) request count, each null when absent. */
export interface Usage { cost: number | null; requests: number | null }

/** The Labs project's own level before launch, per day (from --labs-baseline-out). */
export interface LabsBaseline { at: string; days: number; requestsPerDay: number | null; costPerDayUsd: number | null }

/** What the checkpoint learned about the Labs side of the rewrite; each part null when not measured. */
export interface LabsState { usage: Usage | null; baseline: LabsBaseline | null; cached: boolean | null }

/** What a checkpoint should flag. "stop" means: switch collection off (ops.ts off), then investigate. */
export function evaluate(
  summary: ReturnType<typeof summarize>,
  checks: Check[],
  hours: number,
  costUsd: number | null,
  baseline = BASELINE,
  labs: LabsState = { usage: null, baseline: null, cached: null },
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
  if (labs.cached === false) {
    out.push({ level: 'watch', what: 'radmagelabs.com did not cache a rewritten /signal/ file on a repeat request: every visit also reaches the-signal' });
  }
  if (labs.usage) {
    // Usage is billed by the day, so a window shorter than a day would overstate the daily rate.
    if (hours < 24) { /* reported, not compared */ } else if (!labs.baseline) {
      out.push({ level: 'watch', what: 'no Labs baseline (run --labs-baseline-out before launch): Labs requests reported, not compared' });
    } else if (labs.usage.requests === null || labs.baseline.requestsPerDay === null) {
      out.push({ level: 'watch', what: 'Labs request counts are not in the usage output: read radmagelabs-com on the Usage page' });
    } else {
      const extra = perDay(labs.usage.requests) - labs.baseline.requestsPerDay;
      if (extra > 2 * baseline.labsRewriteRequestsPerDay) {
        out.push({ level: 'stop', what: `Labs CDN requests ${Math.round(extra)} a day above their pre-launch level, over twice the expected /signal/ load ${baseline.labsRewriteRequestsPerDay}` });
      }
    }
  }
  return out;
}

const perDayCost = (b: typeof BASELINE) => b.costPerDayUsd;

function usageRows(json: unknown): Record<string, unknown>[] | null {
  const rows = Array.isArray(json) ? json : (json as { rows?: unknown[]; data?: unknown[] } | null)?.rows ?? (json as { data?: unknown[] } | null)?.data;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : null;
}

interface UsageService { name?: string; product?: string; quantity?: number; cost?: number }
interface UsageGroup { name?: string; services?: UsageService[]; totals?: { cost?: number } }

/**
 * A project's billed amount and CDN request count from `vercel billing usage --group-by project --json`.
 * The CLI (65.12) answers { groupBy: { data: [{ name, services: [{ name, product, quantity, cost }], totals }] } };
 * CDN requests are the service with product "edgeRequest". Flat row lists are read as a fallback.
 */
export function projectUsage(json: unknown, project: string): Usage {
  const groups = (json as { groupBy?: { data?: UsageGroup[] } } | null)?.groupBy?.data;
  if (Array.isArray(groups)) {
    const g = groups.find((x) => x.name === project);
    if (!g) return { cost: null, requests: null };
    const cost = Number(g.totals?.cost ?? (g.services ?? []).reduce((s, x) => s + Number(x.cost ?? 0), 0));
    const req = (g.services ?? []).filter((x) => x.product === 'edgeRequest').map((x) => Number(x.quantity));
    return { cost: Number.isFinite(cost) ? cost : null, requests: req.length > 0 && req.every(Number.isFinite) ? req.reduce((a, b) => a + b, 0) : null };
  }
  const rows = usageRows(json);
  if (!rows) return { cost: null, requests: null };
  let cost = 0; let costFound = false; let requests = 0; let requestsFound = false;
  for (const r of rows) {
    const name = String(r.project ?? r.projectName ?? r.name ?? '');
    if (name !== project) continue;
    const v = Number(r.cost ?? r.amount ?? r.billedCost ?? r.total);
    if (Number.isFinite(v)) { cost += v; costFound = true; }
    const service = String(r.service ?? r.metric ?? r.resource ?? r.serviceName ?? r.product ?? '');
    const q = Number(r.quantity ?? r.usage ?? r.value ?? r.count);
    if (/edge requests?/i.test(service) && Number.isFinite(q)) { requests += q; requestsFound = true; }
  }
  return { cost: costFound ? cost : null, requests: requestsFound ? requests : null };
}

/** The project's billed amount, or null when unreadable. */
export function projectCost(json: unknown, project: string): number | null {
  return projectUsage(json, project).cost;
}

/** Whether the site's CDN serves a repeat request for the snapshot from its cache; null when it does not say. */
export async function repeatIsCached(get: (u: string) => Promise<Response>, base: string): Promise<boolean | null> {
  const u = new URL('data/snapshot.json', base).toString();
  let last = '';
  for (let i = 0; i < 2; i++) {
    const r = await get(u);
    await r.arrayBuffer();
    last = (r.headers.get('x-vercel-cache') ?? '').toUpperCase();
  }
  return last === '' ? null : last === 'HIT' || last === 'STALE' || last === 'PRERENDER';
}

function billingUsage(hours: number): unknown {
  const r = spawnSync('npx', ['--yes', 'vercel@65.12.1', 'billing', 'usage', '--since', `${hours}h`, '--scope', 'radmageirls-projects', '--group-by', 'project', '--json'], { encoding: 'utf8', shell: true, env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' } });
  try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout).slice(0, 400) }; }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n: string, d?: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const base = opt('--base');
  const hours = Number(opt('--hours', '24'));
  const project = opt('--project', 'the-signal')!;
  const labsProject = opt('--labs-project', 'radmagelabs-com')!;
  const outDir = opt('--out', 'local/monitor')!;
  const labsBaselineFile = opt('--labs-baseline', join(outDir, 'labs-baseline.json'))!;
  if (![project, labsProject].every((p) => /^[a-z0-9-]{1,100}$/.test(p)) || !Number.isFinite(hours) || hours <= 0 || hours > 720) { console.error('bad --project, --labs-project or --hours'); process.exit(1); }
  if (args.includes('--labs-baseline-out')) {
    const days = Number(opt('--days', '7'));
    if (!Number.isInteger(days) || days < 1 || days > 30) { console.error('bad --days'); process.exit(1); }
    const u = projectUsage(billingUsage(days * 24), labsProject);
    if (u.cost === null && u.requests === null) { console.error(`no ${labsProject} line in the usage output (CLI logged in?)`); process.exit(1); }
    const b: LabsBaseline = { at: new Date().toISOString(), days, requestsPerDay: u.requests === null ? null : u.requests / days, costPerDayUsd: u.cost === null ? null : u.cost / days };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(labsBaselineFile, JSON.stringify(b, null, 1));
    console.log(`${labsProject} before launch, per day over ${days} days: requests ${b.requestsPerDay ?? 'not in the output'}, usage $${b.costPerDayUsd?.toFixed(2) ?? 'not in the output'}; written ${labsBaselineFile}`);
    process.exit(0);
  }
  if (!base || !base.endsWith('/')) { console.error('usage: node tools/monitor.ts --base https://<site>/ [--hours 24] [--origin <url>] [--api <url>] [--usage]'); process.exit(1); }
  const priv = blobAuth(process.env, 'PRIVATE');
  if (!priv) { console.error('PRIVATE_BLOB_READ_WRITE_TOKEN is not set (read access to the operations logs)'); process.exit(1); }
  const registry = JSON.parse(readFileSync('registry/sources.json', 'utf8')) as SourceEntry[];
  const apiUrl = opt('--api');
  const origin = opt('--origin');
  if (origin !== undefined && !origin.endsWith('/')) { console.error('--origin must end with /'); process.exit(1); }
  const summary = summarize(await entriesSince(priv, Date.now() - hours * 3600_000));
  const checks = await smokeChecks(base, { get: siteGet(base, apiUrl), registry, maxAgeMin: 45, apiUrl });
  let cached: boolean | null = null;
  if (origin) {
    for (const c of await smokeChecks(origin, { get: siteGet(origin), registry, maxAgeMin: 45 })) checks.push({ ...c, name: `project address: ${c.name}` });
    cached = await repeatIsCached(siteGet(base), base);
  }
  let cost: number | null = null;
  let usage: unknown = null;
  let labsUsage: Usage | null = null;
  if (args.includes('--usage')) {
    usage = billingUsage(hours);
    cost = projectCost(usage, project);
    labsUsage = projectUsage(usage, labsProject);
  }
  let labsBaseline: LabsBaseline | null = null;
  try { labsBaseline = JSON.parse(readFileSync(labsBaselineFile, 'utf8')) as LabsBaseline; } catch { /* none yet */ }
  const alerts = evaluate(summary, checks, hours, cost, BASELINE, { usage: labsUsage, baseline: labsBaseline, cached });
  const report = { at: new Date().toISOString(), hours, base, origin, summary, checks, usage, cost, labs: { project: labsProject, usage: labsUsage, baseline: labsBaseline, cached }, alerts };
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `checkpoint-${report.at.replace(/[:.]/g, '')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(`runs ${summary.runs} (${JSON.stringify(summary.byStatus)}), published ${summary.published}, longest gap ${summary.longestGapBetweenPublishesMin} min`);
  console.log(`requests: feed ${summary.requests.feed}, robots ${summary.requests.robots}, 304 ${summary.requests.notModified}; bytes read ${Math.round(summary.bytesRead / 1e6)} MB`);
  console.log(`site checks: ${checks.filter((c) => c.ok).length} of ${checks.length} passed${cost !== null ? `; Vercel usage for ${project}: $${cost.toFixed(2)}` : ''}`);
  if (origin) console.log(`Labs cache on a repeat request: ${cached === null ? 'not reported' : cached ? 'hit' : 'miss'}`);
  if (labsUsage) console.log(`${labsProject}: requests ${labsUsage.requests ?? 'not in the output'}, usage ${labsUsage.cost === null ? 'not in the output' : `$${labsUsage.cost.toFixed(2)}`} in ${hours} h (pre-launch per day: ${labsBaseline ? `${labsBaseline.requestsPerDay ?? '?'} requests, $${labsBaseline.costPerDayUsd?.toFixed(2) ?? '?'}` : 'no baseline'})`);
  for (const a of alerts) console.log(`${a.level.toUpperCase()}: ${a.what}`);
  console.log(alerts.some((a) => a.level === 'stop') ? 'ACTION: run "node tools/ops.ts off", then investigate' : 'no action needed');
  console.log(`written ${file}`);
}
