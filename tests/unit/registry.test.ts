import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SourceEntry } from '../../shared/types.ts';
import { collectable, maySyndicate, mayDisplay, toPublicSource, validateRegistry } from '../../shared/registry.ts';
import { fixtureSources } from '../fixtures/news-day.ts';

const REGISTRY = JSON.parse(readFileSync('registry/sources.json', 'utf8')) as SourceEntry[];
const good = (): SourceEntry => structuredClone(fixtureSources()[0]!);

describe('the committed registry', () => {
  it('has no problems', () => {
    expect(validateRegistry(REGISTRY)).toEqual([]);
  });

  it('enables only READY sources with display permission and no open gates', () => {
    for (const s of REGISTRY.filter((x) => x.enabled)) {
      expect(s.status, s.id).toBe('READY');
      expect(s.rights.display, s.id).toBe('yes');
      expect(s.gates, s.id).toEqual([]);
    }
  });

  it('keeps RT, TASS and CGTN out of production', () => {
    for (const id of ['rt', 'tass', 'cgtn']) {
      const s = REGISTRY.find((x) => x.id === id)!;
      expect(s, id).toBeDefined();
      expect(s.enabled, id).toBe(false);
      expect(s.status, id).not.toBe('READY');
    }
  });

  it('publishes no private paths or internal evidence pointers', () => {
    const text = readFileSync('registry/sources.json', 'utf8');
    // A Windows drive path (a drive letter, a colon and a slash, but not the :// of a URL), or a research-folder pointer.
    expect(text).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)/);
    expect(text).not.toMatch(/local\/research|\(raw:|terms research group/i);
    // The check itself must see a drive path when one is there.
    expect('see ' + 'Z' + ':/folder/x').toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)/);
  });
});

describe('registry rules', () => {
  it('accepts a sound entry', () => {
    expect(validateRegistry([good()])).toEqual([]);
  });

  const cases: [string, (s: SourceEntry) => void, RegExp][] = [
    ['an enabled source that is not READY', (s) => { s.status = 'CONDITIONAL'; }, /only READY sources may be enabled/],
    ['an enabled source with an open gate', (s) => { s.gates = ['recheck the feed']; }, /cannot be enabled while gates remain/],
    ['syndication without display', (s) => { s.enabled = false; s.status = 'RESEARCH'; s.rights.display = 'unknown'; s.rights.syndication = 'yes'; }, /syndication cannot be allowed when display is not/],
    ['READY without display permission', (s) => { s.enabled = false; s.rights.display = 'unknown'; }, /READY requires rights.display = yes/],
    ['READY without recorded attribution', (s) => { s.attribution = ' '; }, /must record the attribution/],
    ['a permission that is not yes, no or unknown', (s) => { (s.rights as unknown as Record<string, string>).images = 'maybe'; }, /rights.images must be yes, no or unknown/],
    ['a feed list in the wrong section', (s) => { s.feeds[0]!.subsection = 'crypto'; }, /is not in section us/],
    ['a feed URL with credentials', (s) => { s.feeds[0]!.url = 'https://u:p@x.example/feed'; }, /must not carry credentials/],
    ['a non-http feed URL', (s) => { s.feeds[0]!.url = 'ftp://x.example/feed'; }, /scheme must be http/],
    ['an unknown country', (s) => { s.country = 'ZZ'; }, /unknown country code ZZ/],
    ['a bad id', (s) => { s.id = 'Bad_ID'; }, /id must be lowercase/],
    ['an interval under 15 minutes', (s) => { s.intervalMinutes = 5; }, /intervalMinutes/],
    ['a non-https homepage', (s) => { s.homepage = 'http://x.example/'; }, /homepage must be an https URL/],
    ['an empty notice', (s) => { s.notice = '  '; }, /notice must be 1 to 400 characters/],
    ['an overlong notice', (s) => { s.notice = 'x'.repeat(401); }, /notice must be 1 to 400 characters/],
  ];
  for (const [name, mutate, expected] of cases) {
    it(`rejects ${name}`, () => {
      const s = good();
      mutate(s);
      const problems = validateRegistry([s]);
      expect(problems.some((p) => expected.test(p)), problems.join(' | ')).toBe(true);
    });
  }

  it('rejects duplicate ids and duplicate feed URLs', () => {
    const a = good();
    const b = good();
    const problems = validateRegistry([a, b]);
    expect(problems.some((p) => /duplicate id/.test(p))).toBe(true);
    expect(problems.some((p) => /feed URL listed twice/.test(p))).toBe(true);
  });

  it('allows a feed to carry another section when it says so', () => {
    const s = good();
    s.feeds[0] = { ...s.feeds[0]!, section: 'markets', subsection: 'crypto' };
    expect(validateRegistry([s])).toEqual([]);
  });
});

describe('what a source may do', () => {
  it('displays only READY sources with display permission', () => {
    const s = good();
    expect(mayDisplay(s)).toBe(true);
    expect(mayDisplay({ ...s, status: 'CONDITIONAL' })).toBe(false);
    expect(mayDisplay({ ...s, rights: { ...s.rights, display: 'unknown' } })).toBe(false);
  });

  it('syndicates only when display and syndication are both yes', () => {
    const s = good();
    expect(maySyndicate({ ...s, rights: { ...s.rights, syndication: 'yes' } })).toBe(true);
    expect(maySyndicate({ ...s, rights: { ...s.rights, syndication: 'unknown' } })).toBe(false);
    expect(maySyndicate({ ...s, rights: { ...s.rights, syndication: 'no' } })).toBe(false);
    expect(maySyndicate({ ...s, status: 'RESEARCH', rights: { ...s.rights, syndication: 'yes' } })).toBe(false);
  });

  it('collects only enabled, displayable, ungated sources with feeds', () => {
    const ok = good();
    const off = { ...good(), id: 'off', enabled: false };
    const gated = { ...good(), id: 'gated', gates: ['x'] };
    const noFeed = { ...good(), id: 'nofeed', feeds: [] };
    expect(collectable([ok, off, gated, noFeed]).map((s) => s.id)).toEqual([ok.id]);
  });

  it('publishes the syndicate flag with the source and nothing about its terms', () => {
    const p = toPublicSource({ ...good(), rights: { display: 'yes', syndication: 'no', excerpt: 'no', images: 'no' } });
    expect(p.syndicate).toBe(false);
    expect(Object.keys(p)).not.toContain('rights');
    expect(Object.keys(p)).not.toContain('statusNote');
  });

  it('publishes a required notice with the source when it has one', () => {
    expect(toPublicSource({ ...good(), notice: 'Source: Example office.' }).notice).toBe('Source: Example office.');
    expect('notice' in toPublicSource(good())).toBe(false);
  });

  it('gives every enabled source that the research found needs a notice its notice', () => {
    for (const id of ['gov-uk-pm', 'gov-uk-fcdo', 'australia-pm', 'japan-kantei', 'taiwan-mofa', 'taiwan-president', 'canada-pm', 'ec-presscorner', 'italy-governo']) {
      const s = REGISTRY.find((x) => x.id === id)!;
      expect(s.enabled, id).toBe(true);
      expect(s.notice?.length ?? 0, id).toBeGreaterThan(10);
    }
  });
});
