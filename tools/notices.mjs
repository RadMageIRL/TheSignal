// Writes THIRD-PARTY-NOTICES.txt from the licence files of every runtime dependency, copied
// verbatim. The build ships the same file next to the site.
//
//   node tools/notices.mjs [--check]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const runtime = Object.entries(lock.packages ?? {})
  .filter(([p, m]) => p.startsWith('node_modules/') && !m.dev)
  .map(([p, m]) => ({ dir: p, name: p.slice(p.lastIndexOf('node_modules/') + 13), version: m.version, license: m.license }))
  .sort((a, b) => a.name.localeCompare(b.name));

const parts = [
  'THIRD-PARTY NOTICES',
  '',
  'The Signal is licensed under the GNU Affero General Public License, version 3 only (see LICENSE).',
  'It includes or uses the following third-party software, each under its own licence, reproduced',
  'below exactly as distributed with the package.',
  '',
];
for (const p of runtime) {
  const file = readdirSync(p.dir).find((f) => /^(licen[cs]e|copying|ofl)(\.(md|txt))?$/i.test(f));
  parts.push('='.repeat(78), `${p.name} ${p.version} (${p.license})`);
  if (file) {
    parts.push(`${file}:`, '', readFileSync(join(p.dir, file), 'utf8').replace(/\r\n/g, '\n').trimEnd(), '');
  } else {
    // Some packages declare a licence but ship no licence file: record exactly what they declare.
    const pj = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
    const author = typeof pj.author === 'string' ? pj.author : pj.author?.name ?? 'not stated';
    const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url ?? 'not stated';
    parts.push('No licence file is distributed with this package.', `package.json declares: license "${pj.license}", author "${author}", repository ${repo}`, '');
  }
}
const out = parts.join('\n') + '\n';
const target = 'THIRD-PARTY-NOTICES.txt';
if (process.argv.includes('--check')) {
  const same = existsSync(target) && readFileSync(target, 'utf8') === out;
  console.log(same ? 'notices up to date' : 'THIRD-PARTY-NOTICES.txt is stale; run node tools/notices.mjs');
  process.exit(same ? 0 : 1);
}
writeFileSync(target, out);
console.log(`wrote ${target}: ${runtime.length} packages, ${out.length} bytes`);
