// Mechanical audit of test names against their assertions. Flags:
//  - a test with no expect() at all;
//  - a test whose name makes a negative claim (never, not, no, drops, rejects, excludes, ...) but
//    whose body has no negative assertion (.not., toBe(false), toBeNull, toHaveLength(0), ...).
// The linter checks itself first against a known-bad sample; a linter that reports nothing because
// it is broken looks exactly like a clean suite.
//
//   node tools/lint-tests.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const NEGATIVE_NAME = /\b(never|not|no|without|drops?|rejects?|refuses?|excludes?|leaves? out|keeps? apart|removes?|stops?|nothing|none|ignores?|cannot)\b/i;
const NEGATIVE_ASSERT = /\.not\.|toBe\(false\)|toBeNull\(\)|toBeUndefined\(\)|toHaveLength\(0\)|toHaveCount\(0\)|toEqual\(\[\]\)|toBe\(0\)|toThrow|toBeLessThan|toBeLessThanOrEqual|toBe\(['"]suspended|toBe\(['"]kept-last-good|toBe\(['"]no['"]\)|status\(\)\)\.toBe\(304\)/;

/** Test blocks: name and body, found by matching the call's parentheses. */
export function blocks(src) {
  const out = [];
  const re = /\b(?:it|test)(?:\.fails)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = src.indexOf('(', m.index) + 1;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push({ name: m[2], body: src.slice(re.lastIndex, i), fails: /\.fails\(/.test(m[0]) });
  }
  return out;
}

// An assertion that pins the whole outcome (an exact list, object, string or number) proves a
// negative claim as well as a .not would; the mutation pass checks that the pinned values are right.
const EXACT_ASSERT = /toEqual\(\s*[[{'"`]|toBe\(\s*['"`\d]|toBeCloseTo\(|toHaveText\(/;
// "rejects X" is shown by an asserted problem or a throw.
const REJECTION = /\b(problems|reasons|warnings)\b[\s\S]{0,160}\b(toBe\(true\)|toContain|toMatch)/;
// HTTP header names are not claims.
const HEADER_WORDS = /\bIf-(None|Modified)-[A-Za-z]+\b/g;

export function problems(src) {
  const out = [];
  for (const b of blocks(src)) {
    const name = b.name.replace(HEADER_WORDS, '');
    if (!/\bexpect\s*\(/.test(b.body)) out.push(`no assertion: ${b.name}`);
    else if (NEGATIVE_NAME.test(name) && !NEGATIVE_ASSERT.test(b.body) && !EXACT_ASSERT.test(b.body) && !REJECTION.test(b.body)) {
      out.push(`negative claim without a negative or exact assertion: ${b.name}`);
    }
  }
  return out;
}

// Self-check on known-bad and known-good samples.
const bad = `it('never shows a cut-off headline', () => { expect(x).toBeTruthy(); });\nit('works', () => { run(); });`;
const good = `it('never shows a cut-off headline', () => { expect(x).not.toContain('y'); });`;
if (problems(bad).length !== 2 || problems(good).length !== 0) {
  console.log('linter self-check FAILED', problems(bad), problems(good));
  process.exit(2);
}

let n = 0;
const flagged = [];
for (const dir of ['tests/unit', 'tests/e2e']) {
  for (const f of readdirSync(dir).filter((x) => /\.(test|spec)\.ts$/.test(x))) {
    const src = readFileSync(join(dir, f), 'utf8');
    n += blocks(src).length;
    for (const p of problems(src)) flagged.push(`${dir}/${f}: ${p}`);
  }
}
console.log(`linter self-check passed; ${n} tests read; ${flagged.length} flagged`);
for (const f of flagged) console.log('  ' + f);
process.exit(flagged.length ? 1 : 0);
