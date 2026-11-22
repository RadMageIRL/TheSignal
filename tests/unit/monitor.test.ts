import { describe, expect, it } from 'vitest';
import { BASELINE, evaluate, projectCost, projectUsage, repeatIsCached } from '../../tools/monitor.ts';

type Summary = Parameters<typeof evaluate>[0];
const healthy = (over: Partial<Summary> = {}): Summary => ({
  runs: 96, byStatus: { publish: 96 }, published: 96, longestGapBetweenPublishesMin: 15, firstRun: 'a', lastRun: 'b',
  requests: { feed: 3000, robots: 80, notModified: 900, perHost: {} }, bytesRead: 350e6, blobWrites: { written: 900, unchanged: 0 },
  failingSources: {}, ...over,
});
const passing = [{ name: 'page answers 200', ok: true, detail: '' }];

describe('48-hour monitoring checkpoints', () => {
  it('raise nothing for a day that matches the launch baseline', () => {
    expect(evaluate(healthy(), passing, 24, 0.1)).toEqual([]);
  });

  it('say stop when a site check fails, nothing publishes, publisher requests double, or usage doubles', () => {
    expect(evaluate(healthy(), [{ name: 'snapshot is under 45 minutes old', ok: false, detail: '80 min' }], 24, null).map((a) => a.level)).toEqual(['stop']);
    expect(evaluate(healthy({ published: 0, byStatus: { 'kept-last-good': 96 } }), passing, 24, null).map((a) => a.what)).toEqual(['no run published in the window']);
    expect(evaluate(healthy({ requests: { feed: 7000, robots: 80, notModified: 0, perHost: {} } }), passing, 24, null)[0]!.level).toBe('stop');
    expect(evaluate(healthy(), passing, 24, 0.5)[0]!.what).toMatch(/Vercel usage/);
    expect(evaluate(healthy({ runs: 0, published: 0, byStatus: {} }), passing, 24, null).map((a) => a.level)).toEqual(['stop']);
  });

  it('scale the baseline to the window, so a 6-hour checkpoint is judged against a quarter day', () => {
    expect(evaluate(healthy({ runs: 24, published: 24, requests: { feed: 800, robots: 20, notModified: 0, perHost: {} }, bytesRead: 100e6 }), passing, 6, 0.03)).toEqual([]);
    expect(evaluate(healthy({ runs: 24, published: 24, requests: { feed: 1700, robots: 20, notModified: 0, perHost: {} } }), passing, 6, null)[0]!.what).toMatch(/twice the baseline/);
  });

  it('flag for watching long publish gaps, duplicate deliveries and sources failing in most runs', () => {
    const a = evaluate(healthy({ longestGapBetweenPublishesMin: 60, runs: 200, failingSources: { 'gov-za': { runs: 150, last: 'timeout' } } }), passing, 24, null);
    expect(a.map((x) => x.level)).toEqual(['watch', 'watch', 'watch']);
    expect(a.map((x) => x.what).join(' ')).toMatch(/gov-za \(timeout\)/);
  });

  it('count the CDN requests the /signal/ rewrite adds on Labs against its own pre-launch level', () => {
    const baseline = { at: 'x', days: 7, requestsPerDay: 40000, costPerDayUsd: 0.5 };
    const labs = (requests: number | null, b: typeof baseline | null = baseline, cached: boolean | null = true) => ({ usage: { cost: 0.6, requests }, baseline: b, cached });
    expect(evaluate(healthy(), passing, 24, 0.1, BASELINE, labs(40000 + 15000))).toEqual([]);
    const over = evaluate(healthy(), passing, 24, 0.1, BASELINE, labs(40000 + 2 * BASELINE.labsRewriteRequestsPerDay + 1000));
    expect(over.map((a) => a.level)).toEqual(['stop']);
    expect(over[0]!.what).toMatch(/Labs CDN requests/);
    // Billed by the day: a 6-hour window is reported, never compared.
    expect(evaluate(healthy({ runs: 24, published: 24, requests: { feed: 800, robots: 20, notModified: 0, perHost: {} }, bytesRead: 100e6 }), passing, 6, 0.03, BASELINE, labs(90000))).toEqual([]);
    expect(evaluate(healthy(), passing, 24, 0.1, BASELINE, labs(50000, null))[0]!.what).toMatch(/no Labs baseline/);
    expect(evaluate(healthy(), passing, 24, 0.1, BASELINE, labs(null))[0]!.what).toMatch(/Usage page/);
    expect(evaluate(healthy(), passing, 24, 0.1, BASELINE, { usage: null, baseline: null, cached: false })[0]!.what).toMatch(/did not cache/);
  });

  it('reads edge requests per project from the usage output', () => {
    const rows = [
      { project: 'radmagelabs-com', service: 'Edge Requests', quantity: 52000, cost: 0 },
      { project: 'radmagelabs-com', service: 'Fast Data Transfer', quantity: 3.2, cost: 0.1 },
      { project: 'the-signal', service: 'Edge Requests', quantity: 9000, cost: 0.01 },
    ];
    expect(projectUsage(rows, 'radmagelabs-com')).toEqual({ cost: 0.1, requests: 52000 });
    expect(projectUsage(rows, 'the-signal')).toEqual({ cost: 0.01, requests: 9000 });
    expect(projectUsage([{ project: 'the-signal', cost: 0.07 }], 'the-signal')).toEqual({ cost: 0.07, requests: null });
  });

  it('tells a cached repeat request from one that reached the origin again', async () => {
    const answer = (states: string[]) => { let i = 0; return async () => new Response('{}', { headers: states[i] ? { 'x-vercel-cache': states[i++]! } : {} }); };
    expect(await repeatIsCached(answer(['MISS', 'HIT']), 'https://radmagelabs.com/signal/')).toBe(true);
    expect(await repeatIsCached(answer(['MISS', 'MISS']), 'https://radmagelabs.com/signal/')).toBe(false);
    expect(await repeatIsCached(answer([]), 'https://radmagelabs.com/signal/')).toBe(null);
  });

  it('reads the project line from the CLI usage output, or says it cannot', () => {
    expect(projectCost([{ project: 'the-signal', cost: 0.07 }, { project: 'other', cost: 3 }], 'the-signal')).toBe(0.07);
    expect(projectCost({ rows: [{ projectName: 'the-signal', amount: '0.02' }] }, 'the-signal')).toBe(0.02);
    expect(projectCost({ error: 'not logged in' }, 'the-signal')).toBe(null);
    expect(BASELINE.feedRequestsPerDay).toBe(3200);
  });
});
