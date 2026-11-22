// Dependency licence audit against AGPL-3.0-only. Reads package-lock.json and each installed
// package.json; lists runtime (shipped) and development dependencies; fails on any licence not on
// the compatible list or on a package with no declared licence.
//
//   node tools/license-audit.mjs [--json]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Permissive and weak-copyleft licences that may be combined with AGPL-3.0-only code.
const COMPATIBLE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0', 'OFL-1.1',
  'BlueOak-1.0.0', 'Python-2.0', 'CC-BY-4.0', 'Unlicense', 'MPL-2.0']);

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const rows = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/')) continue;
  const name = path.slice(path.lastIndexOf('node_modules/') + 13);
  let license = meta.license;
  const pj = join(path, 'package.json');
  if (!license && existsSync(pj)) license = JSON.parse(readFileSync(pj, 'utf8')).license;
  if (typeof license === 'object' && license) license = license.type;
  rows.push({ name, version: meta.version, license: license ?? '(none)', runtime: !meta.dev, optional: !!meta.optional });
}
const parts = (l) => String(l).replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/);
const ok = (l) => parts(l).some((p) => COMPATIBLE.has(p.trim()));
const bad = rows.filter((r) => !ok(r.license) && !(r.optional && !existsSync(join('node_modules', r.name))));
if (process.argv.includes('--json')) { console.log(JSON.stringify({ rows, bad }, null, 1)); process.exit(bad.length ? 1 : 0); }
const runtime = rows.filter((r) => r.runtime);
console.log(`runtime (shipped or used by the collector): ${runtime.length}`);
for (const r of runtime) console.log(`  ${r.name}@${r.version}  ${r.license}`);
const tally = new Map();
for (const r of rows.filter((x) => !x.runtime)) tally.set(r.license, (tally.get(r.license) ?? 0) + 1);
console.log(`development only: ${rows.length - runtime.length} packages: ${[...tally].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')}`);
for (const r of bad) console.log(`NOT ON THE COMPATIBLE LIST: ${r.name}@${r.version} ${r.license}${r.runtime ? ' (runtime)' : ' (dev)'}`);
process.exit(bad.length ? 1 : 0);
