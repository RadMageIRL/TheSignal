// Project-level workload controls for the collector. Every limit has a default and a hard
// ceiling; settings come from environment variables so ingestion can be suspended or throttled
// without a code change or a redeploy of the page. Collection is OFF unless SIGNAL_INGEST=on,
// so a misconfigured deployment never starts fetching publishers by accident. Suspending
// ingestion leaves the last published snapshot and feeds in place; the page states their age.

export interface Controls {
  /** Master switch: when false a run fetches nothing and publishes nothing. */
  ingest: boolean;
  /** Write The Signal's outgoing RSS feeds alongside the snapshot. */
  rss: boolean;
  maxFeedsPerRun: number;
  /** Stop starting new fetches once this many bytes have been read in a run. */
  maxBytesPerRun: number;
  concurrency: number;
  perHost: number;
  timeoutMs: number;
  maxBytesPerResponse: number;
  /** Podcast feeds are cut at this size; the newest episodes come first. */
  podcastMaxBytes: number;
  /** Extra attempts after a network error or HTTP 5xx (never after 4xx). */
  retries: number;
  retryDelayMs: number;
  /** Wall-clock budget; feeds not started by then are skipped. */
  budgetMs: number;
  perSourceCap: number;
  /** A snapshot larger than this is not published. */
  maxSnapshotBytes: number;
  /** Publish only if at least this share of attempted sources answered. */
  minSourceShare: number;
  /** Publish only if the run produced at least this many articles. */
  minArticles: number;
  /** Earlier snapshots kept for rollback. */
  historyKeep: number;
}

export const DEFAULT_CONTROLS: Controls = {
  ingest: false,
  rss: true,
  maxFeedsPerRun: 150,
  maxBytesPerRun: 40 * 1024 * 1024,
  concurrency: 6,
  perHost: 2,
  timeoutMs: 10_000,
  maxBytesPerResponse: 3 * 1024 * 1024,
  podcastMaxBytes: 600 * 1024,
  retries: 1,
  retryDelayMs: 1500,
  budgetMs: 90_000,
  perSourceCap: 40,
  maxSnapshotBytes: 2 * 1024 * 1024,
  minSourceShare: 0.6,
  minArticles: 50,
  historyKeep: 24,
};

type NumKey = Exclude<keyof Controls, 'ingest' | 'rss'>;

/** [environment variable, floor, ceiling] for every numeric control. Values outside are clamped. */
export const LIMITS: Record<NumKey, [string, number, number]> = {
  maxFeedsPerRun: ['SIGNAL_MAX_FEEDS', 1, 250],
  maxBytesPerRun: ['SIGNAL_MAX_RUN_BYTES', 1024 * 1024, 64 * 1024 * 1024],
  concurrency: ['SIGNAL_CONCURRENCY', 1, 8],
  perHost: ['SIGNAL_PER_HOST', 1, 2],
  timeoutMs: ['SIGNAL_TIMEOUT_MS', 1000, 15_000],
  maxBytesPerResponse: ['SIGNAL_MAX_RESPONSE_BYTES', 64 * 1024, 5 * 1024 * 1024],
  podcastMaxBytes: ['SIGNAL_PODCAST_MAX_BYTES', 64 * 1024, 1024 * 1024],
  retries: ['SIGNAL_RETRIES', 0, 2],
  retryDelayMs: ['SIGNAL_RETRY_DELAY_MS', 0, 10_000],
  budgetMs: ['SIGNAL_BUDGET_MS', 5000, 240_000],
  perSourceCap: ['SIGNAL_PER_SOURCE_CAP', 1, 60],
  maxSnapshotBytes: ['SIGNAL_MAX_SNAPSHOT_BYTES', 64 * 1024, 4 * 1024 * 1024],
  minSourceShare: ['SIGNAL_MIN_SOURCE_SHARE', 0.1, 1],
  minArticles: ['SIGNAL_MIN_ARTICLES', 1, 5000],
  historyKeep: ['SIGNAL_HISTORY_KEEP', 1, 48],
};

function onOff(v: string | undefined, fallback: boolean, name: string, warnings: string[]): boolean {
  if (v === undefined || v === '') return fallback;
  const t = v.trim().toLowerCase();
  if (t === 'on' || t === 'true' || t === '1') return true;
  if (t === 'off' || t === 'false' || t === '0') return false;
  warnings.push(`${name}=${v} is not on/off; using ${fallback ? 'on' : 'off'}`);
  return fallback;
}

export function readControls(env: Record<string, string | undefined>): { controls: Controls; warnings: string[] } {
  const warnings: string[] = [];
  const c: Controls = { ...DEFAULT_CONTROLS };
  // Ingestion needs an explicit "on"; anything else (unset, typo) keeps it off.
  c.ingest = onOff(env.SIGNAL_INGEST, false, 'SIGNAL_INGEST', warnings);
  c.rss = onOff(env.SIGNAL_RSS, DEFAULT_CONTROLS.rss, 'SIGNAL_RSS', warnings);
  for (const key of Object.keys(LIMITS) as NumKey[]) {
    const [name, lo, hi] = LIMITS[key];
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) { warnings.push(`${name}=${raw} is not a number; using ${c[key]}`); continue; }
    const v = Math.min(hi, Math.max(lo, n));
    if (v !== n) warnings.push(`${name}=${raw} is outside ${lo}..${hi}; using ${v}`);
    c[key] = key === 'minSourceShare' ? v : Math.round(v);
  }
  return { controls: c, warnings };
}
