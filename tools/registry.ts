// Registry tool.
//   node tools/registry.ts check            validate registry/sources.json and print totals (exit 1 on problems)
//   node tools/registry.ts matrix [file]    write the source availability matrix (Markdown) to file
//                                           (default docs/SOURCE_MATRIX.md, a local-only document)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { SourceEntry, SectionId, SourceStatus } from '../shared/types.ts';
import { validateRegistry, maySyndicate, mayDisplay, collectable } from '../shared/registry.ts';
import { SECTION_TITLES, SECTION_ORDER } from '../shared/labels.ts';

const REG = 'registry/sources.json';
const list = JSON.parse(readFileSync(REG, 'utf8')) as SourceEntry[];
const [cmd = 'check', outArg] = process.argv.slice(2);
const STATUSES: SourceStatus[] = ['READY', 'CONDITIONAL', 'RESEARCH', 'DEFERRED', 'UNAVAILABLE'];

const count = (f: (s: SourceEntry) => boolean) => list.filter(f).length;
const problems = validateRegistry(list);

if (cmd === 'check') {
  for (const p of problems) console.log('PROBLEM', p);
  console.log(`${list.length} sources: ${STATUSES.map((st) => `${st} ${count((s) => s.status === st)}`).join(', ')}`);
  console.log(`display allowed ${count(mayDisplay)}, RSS redistribution allowed ${count(maySyndicate)}, collectable now ${collectable(list).length}`);
  const ready = list.filter((s) => s.status === 'READY');
  console.log(`READY countries: ${[...new Set(ready.map((s) => s.country))].sort().join(' ')}`);
  process.exit(problems.length ? 1 : 0);
}

if (cmd === 'matrix') {
  const out = outArg ?? 'docs/SOURCE_MATRIX.md';
  interface Row { sourceId: string; verdict: string; items: number; newestAgeHours: number | null; robots: boolean | null }
  const val: Row[] = existsSync('local/research/feeds/validation-latest.json')
    ? (JSON.parse(readFileSync('local/research/feeds/validation-latest.json', 'utf8')) as { results: Row[] }).results : [];
  const check = (id: string) => val.filter((r) => r.sourceId === id)
    .map((r) => `${r.verdict} ${r.items}${r.newestAgeHours === null ? '' : ` (${r.newestAgeHours}h)`}${r.robots === false ? ' robots-no' : ''}`).join('; ') || 'n/a';
  const esc = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  lines.push('# Source Availability Matrix', '');
  lines.push(`Generated from ${REG} on ${new Date().toISOString().slice(0, 16)}Z. Local only.`, '');
  lines.push('Status: READY = feed works, terms affirmatively allow headline-and-link display on a public non-commercial site, robots.txt allows the feed, identity requirements met. CONDITIONAL = needs permission, a legal reading, registration, identity or a sanctions review. RESEARCH = works but no terms address reuse. DEFERRED = paid or heavy. UNAVAILABLE = no official feed, dead, stale or blocked.', '');
  lines.push('Rights columns: D = website display, S = redistribution through The Signal\'s RSS feeds, E = excerpts, I = images (y = yes, n = no, ? = not established).', '');
  lines.push(`**Totals:** ${list.length} sources. ${STATUSES.map((st) => `${st} ${count((s) => s.status === st)}`).join(', ')}. Display allowed ${count(mayDisplay)}; RSS redistribution allowed ${count(maySyndicate)}; collectable now ${collectable(list).length}.`, '');
  lines.push('| Section | READY | CONDITIONAL | RESEARCH | DEFERRED | UNAVAILABLE | RSS ok |', '|---|---|---|---|---|---|---|');
  for (const sec of SECTION_ORDER) {
    const inSec = (s: SourceEntry) => s.section === sec;
    lines.push(`| ${SECTION_TITLES[sec]} | ${STATUSES.map((st) => count((s) => inSec(s) && s.status === st)).join(' | ')} | ${count((s) => inSec(s) && maySyndicate(s))} |`);
  }
  const letter = (p: string) => (p === 'yes' ? 'y' : p === 'no' ? 'n' : '?');
  const order = (s: SourceEntry) => STATUSES.indexOf(s.status);
  for (const sec of SECTION_ORDER as SectionId[]) {
    lines.push('', `## ${SECTION_TITLES[sec]}`, '', '| Source | Country | Status | D S E I | On | Why | Feed check |', '|---|---|---|---|---|---|---|');
    for (const s of list.filter((x) => x.section === sec).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))) {
      const r = s.rights;
      const why = esc([s.statusNote, s.restrictions, ...s.gates.map((g) => `Gate: ${g}`)].filter(Boolean).join(' '));
      lines.push(`| ${esc(s.name)} | ${s.country} | ${s.status} | ${letter(r.display)} ${letter(r.syndication)} ${letter(r.excerpt)} ${letter(r.images)} | ${s.enabled ? 'yes' : ''} | ${why} | ${check(s.id)} |`);
    }
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log('wrote', out, problems.length ? `(registry has ${problems.length} problems; run check)` : '');
}
