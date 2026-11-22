import { describe, expect, it } from 'vitest';
import { BASELINE, evaluate, projectCost } from '../../tools/monitor.ts';

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

  it('reads the project line from the CLI usage output, or says it cannot', () => {
    expect(projectCost([{ project: 'the-signal', cost: 0.07 }, { project: 'other', cost: 3 }], 'the-signal')).toBe(0.07);
    expect(projectCost({ rows: [{ projectName: 'the-signal', amount: '0.02' }] }, 'the-signal')).toBe(0.02);
    expect(projectCost({ error: 'not logged in' }, 'the-signal')).toBe(null);
    expect(BASELINE.feedRequestsPerDay).toBe(3200);
  });
});
