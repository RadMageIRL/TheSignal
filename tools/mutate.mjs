// Mutation pass: each mutant breaks one rule the code is meant to guarantee, and at least one
// unit test must fail for it. Edits sources in place and always restores them (and checks that
// it did). Runs unit tests only. Do not build or run anything else on this tree while it runs.
//
//   node tools/mutate.mjs [filter]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const R = String.raw;
// [label, file, exact text, replacement]
const M = [
  // Clustering and counting
  ['minSharedRare 2 -> 1', 'shared/cluster.ts', 'minSharedRare: 2,', 'minSharedRare: 1,'],
  ['pairThreshold 0.34 -> 0.15', 'shared/cluster.ts', 'pairThreshold: 0.34,', 'pairThreshold: 0.15,'],
  ['pairThreshold 0.34 -> 0.7', 'shared/cluster.ts', 'pairThreshold: 0.34,', 'pairThreshold: 0.7,'],
  ['windowHours 36 -> 200', 'shared/cluster.ts', 'windowHours: 36,', 'windowHours: 200,'],
  ['rareFloor 10 -> 3', 'shared/cluster.ts', 'rareFloor: 10,', 'rareFloor: 3,'],
  ['place veto off', 'shared/cluster.ts', '  if (placesConflict(x.tokens, y.tokens)) return 0;\n', ''],
  ['years distinctive', 'shared/cluster.ts', '!(n >= 1990 && n <= 2099)', 'true'],
  ['day boundary 31 -> 30', 'shared/cluster.ts', 'n > 31', 'n > 30'],
  ['origins ignore syndication', 'shared/cluster.ts', 'if (prev) union(prev, k); else byTitle.set(t, k);', 'byTitle.set(t, k);'],
  ['origins ignore networks', 'shared/cluster.ts', ": a.network ? 'net:' + a.network : 'src:' + a.sourceId", ": 'src:' + a.sourceId"],
  ['INT and EU counted as countries', 'shared/cluster.ts', '.filter((c) => !NOT_A_COUNTRY.has(c))', ''],
  ['same-outlet repeat marked as copy', 'shared/cluster.ts', 'else if (first.sourceId !== a.sourceId) note.sameAs = first.id;', 'else note.sameAs = first.id;'],
  ['single wire credit marked shared', 'shared/cluster.ts', '?.size ?? 0) >= 2) note.wire', '?.size ?? 0) >= 1) note.wire'],
  ['marker strip off', 'shared/cluster.ts', "return t.replace(MARKERS, '');", 'return t;'],
  // Ranking and placement
  ['publisher cap 2 -> 3', 'shared/layout.ts', 'const PER_PUBLISHER_PER_LIST = 2;', 'const PER_PUBLISHER_PER_LIST = 3;'],
  ['network cap off', 'shared/layout.ts', 'const owner = lead.network ?? lead.sourceId;', 'const owner = lead.sourceId;'],
  ['half-life 10 -> 12', 'shared/layout.ts', 'export const HALF_LIFE_HOURS = 10;', 'export const HALF_LIFE_HOURS = 12;'],
  ['corroboration weight 0', 'shared/layout.ts', '1 + 0.9 * Math.log2(1 + c.originCount) + 0.5 * Math.log2(1 + c.countryCount)', '1'],
  ['soft-topic factor off', 'shared/layout.ts', ' * softFactor(lead.title);', ';'],
  ['airwaves cap 1 -> 2', 'shared/layout.ts', "const cap = section === 'airwaves' ? 1 :", "const cap = section === 'airwaves' ? 2 :"],
  ['headline place ignored', 'shared/layout.ts', '    if (place) return { section, sub: place };\n', ''],
  ['U.S. story naming abroad stays U.S.', 'shared/layout.ts', "  if (section === 'us' && place && !domestic) section = 'world';\n", ''],
  ['world story naming U.S. stays world', 'shared/layout.ts', "    if (domestic) return { section: 'us', sub: 'national' };\n", ''],
  ['US domestic off', 'shared/regions.ts', "  if (US_PHRASES.some((p) => norm.includes(' ' + p + ' '))) return true;\n  return norm.trim().split(' ').some((w) => US_WORDS.has(w));", '  return false;'],
  ['sports factor 0.35 -> 1', 'shared/topics.ts', 'sports: 0.35,', 'sports: 1,'],
  ['advice not detected', 'shared/topics.ts', 'if (ADVICE.test(t) || FIRST', 'if (false || FIRST'],
  ['first-person question not detected', 'shared/topics.ts', ' || FIRST_PERSON_QUESTION.test(t)', ''],
  ['programming not detected', 'shared/topics.ts', "  if (PROGRAMMING.test(t)) return 'programming';\n", ''],
  // RSS
  ['RSS ignores redistribution permission', 'shared/rss.ts', 'const ok = (a: Article) => srcs.get(a.sourceId)?.syndicate === true;', 'const ok = (a: Article) => true;'],
  ['RSS treats unknown permission as allowed', 'shared/rss.ts', '?.syndicate === true;', '?.syndicate !== false;'],
  ['RSS section scoping off', 'shared/rss.ts', "spec.scope === 'all' || a.section === spec.section", 'true'],
  ['RSS byte cap off', 'shared/rss.ts', 'while (bytesOf(xml) > maxBytes && items.length > 0) {', 'while (false) {'],
  ['RSS item cap off', 'shared/rss.ts', '    if (items.length >= cap) break;\n', ''],
  ['RSS URL dedupe off', 'shared/rss.ts', '!link || seenUrl.has(link) || ', '!link || '],
  ['RSS ampersand not escaped', 'shared/rss.ts', ".replace(/&/g, '&amp;')", ''],
  ['RSS invalid characters kept', 'shared/rss.ts', "return s.replace(XML_INVALID, '')", 'return s'],
  ['RSS build date is now', 'shared/rss.ts', '<lastBuildDate>${rfc822(snap.generatedAt)}</lastBuildDate>', '<lastBuildDate>${rfc822(new Date().toISOString())}</lastBuildDate>'],
  ['RSS invents pubDate', 'shared/rss.ts', '  if (e.a.publishedAt) parts.push(`<pubDate>${rfc822(e.a.publishedAt)}</pubDate>`);', '  parts.push(`<pubDate>${rfc822(e.a.publishedAt ?? e.a.fetchedAt)}</pubDate>`);'],
  ['RSS guid depends on headline', 'shared/rss.ts', '${escapeXml(itemGuid(e.a.id))}', '${escapeXml(itemGuid(e.a.id + e.a.title))}'],
  ['RSS notice dropped', 'shared/rss.ts', "const notice = src.notice ? ` ${src.notice}` : '';", "const notice = '';"],
  ['RSS story lead ignores permission', 'shared/rss.ts', 'const pick = lead && ok(lead) ? lead : pickLead(eligible);', 'const pick = lead ?? pickLead(eligible);'],
  ['RSS unsafe link kept', 'shared/rss.ts', '    const link = safeLink(e.a.url);\n    const key', '    const link = e.a.url;\n    const key'],
  // Registry
  ['registry allows enabled non-READY', 'shared/registry.ts', "      if (s.status !== 'READY') out.push(`${at} only READY sources may be enabled`);\n", ''],
  ['maySyndicate ignores syndication', 'shared/registry.ts', "return mayDisplay(s) && s.rights.syndication === 'yes';", 'return mayDisplay(s);'],
  ['collectable ignores gates', 'shared/registry.ts', 's.gates.length === 0 && ', ''],
  ['notice not published', 'shared/registry.ts', '  if (notice) p.notice = notice;\n', ''],
  // Controls and publishing
  ['ingestion on by default', 'ingest/controls.ts', "c.ingest = onOff(env.SIGNAL_INGEST, false,", "c.ingest = onOff(env.SIGNAL_INGEST, true,"],
  ['controls not clamped', 'ingest/controls.ts', 'const v = Math.min(hi, Math.max(lo, n));', 'const v = n;'],
  ['suspended run still collects', 'ingest/publish.ts', "if (!c.ingest) return { status: 'suspended'", "if (false) return { status: 'suspended'"],
  ['source-share floor off', 'ingest/publish.ts', 'sourcesOk / sourcesAttempted < c.minSourceShare', 'sourcesOk / sourcesAttempted < 0'],
  ['snapshot size limit off', 'ingest/publish.ts', 'if (size > c.maxSnapshotBytes)', 'if (false)'],
  ['retries off by one', 'ingest/run.ts', 'attempt < opts.retries', 'attempt <= opts.retries'],
  ['4xx retried', 'ingest/run.ts', '(r.status >= 500 || r.status === 0)', '(r.status >= 400 || r.status === 0)'],
  ['run byte budget off', 'ingest/run.ts', 'if (bytes >= opts.maxBytesPerRun)', 'if (false)'],
  ['feed cap off', 'ingest/run.ts', 'const tasks = all.slice(0, opts.maxFeeds);', 'const tasks = all;'],
  ['wire filter off', 'ingest/run.ts', '        if (a.wire && drop.has(a.wire.toLowerCase())) continue;\n', ''],
  ['path filter off', 'ingest/run.ts', '        if (paths.length > 0 && excludedPath(a.url, paths)) continue;\n', ''],
  // Parsing, URLs, robots (Phase 0 guards)
  ['entity guard off', 'ingest/parse.ts', 'if (/<!ENTITY/i.test(xml.slice(0, 4096))) {', 'if (false) {'],
  ['truncation close off', 'ingest/parse.ts', '  if (opts.truncated) xml = closeTruncated(xml);', ''],
  ['future-date guard off', 'shared/text.ts', 'if (t > nowMs + 15 * 60_000) return null;', ''],
  ['robots tie-break flipped', 'ingest/robots.ts', 'r.pattern.length > best.pattern.length', 'r.pattern.length < best.pattern.length'],
  ['AP dateline lost', 'ingest/normalize.ts', R`['AP', /\bAssociated Press\b|\(AP\)/],`, R`['AP', /\bAssociated Press\b/],`],
  ['tracking params kept', 'shared/url.ts', '    if (TRACKING_PREFIX.some((p) => lk.startsWith(p))) continue;\n', ''],
  ['credentials allowed', 'shared/url.ts', '  if (u.username || u.password) return null;\n', ''],
  // Snapshot schema
  ['schema allows unsafe link', 'shared/schema.ts', "  if (!safeLink(a.u)) return 'unsafe link';\n", ''],
  ['schema trusts unknown mode', 'shared/schema.ts', "mode: input.mode === 'live' ? 'live' : 'prototype',", "mode: input.mode as 'live',"],
  // Search
  ['search country filter off', 'src/lib/search.ts', "(f.country === 'all' || a.country === f.country)", 'true'],
  ['search age filter off', 'src/lib/search.ts', '(within === Infinity || nowMs - time(a) <= within)', 'true'],
  ['search coverage sort off', 'src/lib/search.ts', "(f.sort === 'coverage' ? outlets(y) - outlets(x) : 0)", '0'],
  // HTTP validators
  ['If-None-Match does not win', 'tools/http-cache.ts', '  if (inm !== undefined) {', '  if (false) {'],
];

const filter = process.argv[2];
const hash = (s) => createHash('sha256').update(s).digest('hex');

function run() {
  const r = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], { encoding: 'utf8', shell: true });
  const out = r.stdout + r.stderr;
  const failed = /Tests\s+(\d+) failed/.exec(out);
  const passed = /(\d+) passed/.exec(out);
  if (!failed && !passed) return -1;
  return failed ? Number(failed[1]) : 0;
}

const files = [...new Set(M.map((m) => m[1]))];
const before = new Map(files.map((f) => [f, hash(readFileSync(f, 'utf8'))]));
const base = run();
console.log('baseline failures:', base);
if (base !== 0) { console.log('baseline must be clean; stopping'); process.exit(1); }
let caught = 0, total = 0;
const survived = [];
for (const [label, file, from, to] of M) {
  if (filter && !label.includes(filter)) continue;
  total++;
  const orig = readFileSync(file, 'utf8');
  const at = orig.indexOf(from);
  if (at < 0 || orig.indexOf(from, at + 1) >= 0) { console.log(at < 0 ? 'MISSING ' : 'AMBIGUOUS', label); survived.push(label + ' (pattern)'); continue; }
  try {
    writeFileSync(file, orig.replace(from, to));
    const f = run();
    const ok = f > 0;
    if (ok) caught++; else survived.push(label);
    console.log(ok ? 'caught  ' : 'SURVIVED', String(f).padStart(3), label);
  } finally {
    writeFileSync(file, orig);
  }
}
for (const f of files) if (hash(readFileSync(f, 'utf8')) !== before.get(f)) { console.log('RESTORE FAILED', f); process.exit(2); }
console.log(`${caught}/${total} mutants caught; sources restored`);
if (survived.length) { console.log('survived:', survived.join('; ')); process.exit(1); }
