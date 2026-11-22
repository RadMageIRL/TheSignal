import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWire, validateWire } from '../../shared/schema.ts';
import type { WireSnapshot } from '../../shared/wire.ts';

const fixture = (): WireSnapshot => JSON.parse(readFileSync('tests/fixtures/site/snapshot.json', 'utf8')) as WireSnapshot;

describe('snapshot schema', () => {
  it('accepts the fixture snapshot', () => {
    expect(validateWire(fixture())).toEqual([]);
    expect(parseWire(fixture()).dropped).toBe(0);
  });

  it('rejects and drops an article whose link is not a safe http(s) URL', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://u:p@x.example/', 'http://localhost/x']) {
      const w = fixture();
      w.articles[0]!.u = bad;
      expect(validateWire(w).some((p) => /unsafe link/.test(p)), bad).toBe(true);
      const { wire, dropped } = parseWire(w);
      expect(dropped, bad).toBe(1);
      expect(wire.articles.some((a) => a.u === bad), bad).toBe(false);
    }
  });

  it('drops articles from sources the snapshot does not list, overlong titles and duplicate ids', () => {
    const w = fixture();
    w.articles[0]!.s = 'ghost';
    w.articles[1]!.t = 'x'.repeat(401);
    w.articles[2]!.i = w.articles[3]!.i;
    expect(parseWire(w).dropped).toBe(3);
    const problems = validateWire(w);
    expect(problems.slice(0, 3)).toEqual(['article 0: unknown source', 'article 1: bad title', 'article 3: duplicate id']);
    // The story that contained the dropped first article is reported too.
    expect(problems.slice(3).every((p) => /refers to a missing article/.test(p))).toBe(true);
  });

  it('removes dropped articles from stories so no story points at a missing headline', () => {
    const w = fixture();
    const target = w.clusters.find((c) => c.a.length > 2)!;
    const victim = target.a[0]!;
    w.articles.find((a) => a.i === victim)!.u = 'javascript:x';
    const { wire } = parseWire(w);
    expect(wire.clusters.find((c) => c.i === target.i)!.a).not.toContain(victim);
    expect(validateWire(w).some((p) => /refers to a missing article/.test(p))).toBe(true);
  });

  it('never presents an unknown mode as live', () => {
    const w = fixture() as unknown as Record<string, unknown>;
    w.mode = 'LIVE!';
    expect(parseWire(w).wire.mode).toBe('prototype');
    expect(validateWire(w)).toContain('bad mode');
  });

  it('refuses a document that is not a version 1 snapshot or is over the size limits', () => {
    expect(() => parseWire(null)).toThrow();
    expect(() => parseWire({ v: 2 })).toThrow(/unsupported/);
    expect(() => parseWire({ ...fixture(), articles: 'nope' })).toThrow(/malformed/);
    const big = fixture();
    big.articles = Array.from({ length: 20_001 }, () => big.articles[0]!);
    expect(() => parseWire(big)).toThrow(/size limits/);
  });

  it('keeps only known lists in the layout and only string ids in them', () => {
    const w = fixture() as unknown as { layout: Record<string, Record<string, unknown>> };
    w.layout.us!.national = ['ok', 42, { evil: true }];
    w.layout.us!.bogus = ['x'];
    const { wire } = parseWire(w);
    expect(wire.layout.us.national).toEqual(['ok']);
    expect(Object.keys(wire.layout.us)).not.toContain('bogus');
  });
});
