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
  ['RSS invents pubDate', 'shared/rss.ts', '  if (e.a.publishedAt) parts.push(`<pubDate>${rfc822(e.a.publishedAt)}</pubDate>`);', '  parts.push(`<pubDate>${rfc822(e.a.publishedAt ?? e.a.firstSeenAt)}</pubDate>`);'],
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
  ['4xx retried', 'ingest/fetch.ts', '(r.status >= 500 || r.status === 0)', '(r.status >= 400 || r.status === 0)'],
  ['run byte budget off', 'ingest/run.ts', 'if (spent() >= opts.maxBytesPerRun)', 'if (false)'],
  ["feed cap off", "ingest/run.ts", "  const tasks = due.slice(0, opts.maxFeeds);", "  const tasks = due;"],
  ["wire filter off", "ingest/run.ts", "const kept = shown.filter((a) => !(a.wire && drop.has(a.wire.toLowerCase())) && !(paths.length > 0 && excludedPath(a.url, paths)));", "const kept = shown.filter((a) => !(paths.length > 0 && excludedPath(a.url, paths)));"],
  ["path filter off", "ingest/run.ts", "const kept = shown.filter((a) => !(a.wire && drop.has(a.wire.toLowerCase())) && !(paths.length > 0 && excludedPath(a.url, paths)));", "const kept = shown.filter((a) => !(a.wire && drop.has(a.wire.toLowerCase())));"],
  // Parsing, URLs, robots (Phase 0 guards)
  ['entity guard off', 'ingest/parse.ts', 'if (/<!ENTITY/i.test(xml.slice(0, 4096))) {', 'if (false) {'],
  ['truncation close off', 'ingest/parse.ts', '  if (opts.truncated) xml = closeTruncated(xml);', ''],
  ['future-date guard off', 'shared/text.ts', 'if (t > nowMs + 15 * 60_000) return null;', ''],
  ['robots tie-break flipped', 'ingest/robots.ts', 'r.pattern.length > best.pattern.length', 'r.pattern.length < best.pattern.length'],
  // robots.txt before publisher content (regression gate)
  ["collector skips the robots gate", "ingest/run.ts", "      if (!verdict.allowed) {\n        const deferredRead", "      if (false) {\n        const deferredRead"],
  ["collector follows redirects unchecked", "ingest/run.ts", "          return (await robots.check(next.toString(), userAgent)).reason ?? (await robots.pace(next.toString(), userAgent));", "          return null;"],
  ['fetchFeed ignores the redirect permit', 'ingest/fetch.ts', 'if (hop > 0 && validators.permitRedirect) {', 'if (false) {'],
  ['unreachable robots.txt allows all', 'ingest/robots.ts', "  return { kind: 'unreachable', reason: r.error ?? `HTTP ${r.status}` };", "  return { kind: 'none', status: r.status };"],
  ["rate limit read as no robots.txt", "ingest/robots.ts", "const NOT_FOUND = new Set([404, 410]);", "const NOT_FOUND = new Set([404, 410, 419, 429]);"],
  ['robots.txt cache never expires', 'ingest/robots.ts', 'age < ROBOTS_MAX_AGE_MS', 'age < Infinity'],
  ['robots.txt requested per feed', 'ingest/robots.ts', '    if (known) return known;\n', ''],
  ['unreachable answer kept', 'ingest/robots.ts', "if (found.kind !== 'unreachable') o.cache?.set(", 'if (true) o.cache?.set('],
  ['validator requests before robots', 'tools/validate-sources.ts', '  if (!first.allowed) {', '  if (false) {'],
  ['validator follows disallowed redirects', 'tools/validate-sources.ts', '      if (v.allowed) return null;', '      return null;'],
  ["Crawl-delay ignored", "ingest/robots.ts", "      const delaySec = crawlDelayOf(found, o.token);", "      const delaySec = 0;"],
  ['robots.txt request not paced', 'ingest/robots.ts', '          lastAt.set(origin, clock());\n', ''],
  ["concurrent requests share a slot", "ingest/robots.ts", "    lastAt.set(origin, slot);\n    if (slot > now) await sleep(slot - now);", "    if (slot > now) await sleep(slot - now);"],
  ["long Crawl-delay waited out in a run", "ingest/robots.ts", "    if (slot - now > maxWait) return delaySec;", "    if (false) return delaySec;"],
  ["collector skips pacing", "ingest/run.ts", "        if (deferred) return null;\n        fr.lastSentAt = clock();", "        fr.lastSentAt = clock();"],
  // Headlines in other languages
  ['non-English headlines grouped', 'ingest/run.ts', '    ...clusterArticles(news.filter((a) => isEnglish(a.language))),\n    ...news.filter((a) => !isEnglish(a.language)).flatMap((a) => clusterArticles([a])),\n', '    ...clusterArticles(news),\n'],
  ['English variants not English', 'shared/languages.ts', "return primaryLanguage(tag) === 'en';", "return tag === 'en';"],
  ['registry ignores unnamed languages', 'shared/registry.ts', "if (!knownLanguage(s.language ?? ''))", 'if (false)'],
  ['RSS language unmarked', 'shared/rss.ts', '  if (foreign) parts.push(`<dc:language>${escapeXml(e.a.language)}</dc:language>`);\n', ''],
  ['search language filter off', 'src/lib/search.ts', "(f.language === 'all' || primaryLanguage(a.language) === f.language)", 'true'],
  ['hidden language still shown', 'src/lib/data.ts', 'if (hide.has(primaryLanguage(s.language))) off.add(s.id);', 'if (false) off.add(s.id);'],
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
  // Step 0: scheduling, first-seen times, state, publishing and the smoke-test audit
  ["interval ignored", "ingest/state.ts", "return Math.max(ms(fs.lastRequestAt) + intervalMinutes * 60_000 + INTERVAL_MARGIN_MS, ms(fs.nextDueAt));", "return ms(fs.nextDueAt);"],
  ["backoff ignored", "ingest/state.ts", "return Math.max(ms(fs.lastRequestAt) + intervalMinutes * 60_000 + INTERVAL_MARGIN_MS, ms(fs.nextDueAt));", "return ms(fs.lastRequestAt) + intervalMinutes * 60_000 + INTERVAL_MARGIN_MS;"],
  ["backoff never doubles", "ingest/state.ts", "interval * 2 ** Math.min(failures, 20)", "interval"],
  ["feed reservations missing", "ingest/state.ts", "  for (const k of feedKeys) copy.feeds[k] = { ...(copy.feeds[k] ?? { failures: 0, items: [] }), lastRequestAt: u };\n", ""],
  ["host reservations missing", "ingest/state.ts", "  for (const o of origins) copy.hosts[o] = { ...copy.hosts[o], lastRequestAt: u };\n", ""],
  ["malformed state accepted", "ingest/state.ts", "return p.length > 0 ? { problem: p.join('; ') } : { state: x as CollectorState, fresh: false };", "return { state: x as CollectorState, fresh: false };"],
  ["feeds requested before due", "ingest/run.ts", "  const due = all.filter((t) => t.earliest <= nowMs + DUE_WAIT_MS);\n", "  const due = all;\n"],
  ["due feed not waited for", "ingest/run.ts", "      if (wait > 0) { await sleep(wait); fr.waitedMs += wait; }\n", ""],
  ["first-seen reset every run", "ingest/run.ts", "    const first = seen[a.id]?.f ?? nowIso;", "    const first = nowIso;"],
  ["re-dated items believed", "ingest/run.ts", "const believable = a.publishedAt !== null && Date.parse(a.publishedAt) <= Date.parse(first) + DATE_SKEW_MS;", "const believable = a.publishedAt !== null;"],
  ["stored items not shown", "ingest/run.ts", "      shown = recent ? fs.items : [];", "      shown = [];"],
  ["no conditional requests", "ingest/run.ts", "        etag: conditional ? stored.etag : undefined,", "        etag: undefined,"],
  ["cool-down ignored", "ingest/run.ts", "      if (coolingUntil(origin) > clock()) {", "      if (false) {"],
  ["cool-down never starts", "ingest/run.ts", "    if (r.status === 419 || r.status === 429) {", "    if (false) {"],
  ["Retry-After ignored", "ingest/run.ts", "Math.max(COOL_DOWN_MS, asked)", "COOL_DOWN_MS"],
  ["items kept after 404", "ingest/run.ts", "        if (!fr.retryable) fs.items = [];\n", ""],
  ["saved host times ignored", "ingest/run.ts", "  for (const [o, h] of Object.entries(hosts)) if (h.lastRequestAt) hostTimes.set(o, Date.parse(h.lastRequestAt));\n", ""],
  ["redirect hops not paced", "ingest/run.ts", "(await robots.check(next.toString(), userAgent)).reason ?? (await robots.pace(next.toString(), userAgent));", "(await robots.check(next.toString(), userAgent)).reason ?? null;"],
  ["Crawl-delay margin off", "ingest/robots.ts", "prev + (delaySec > 0 ? delaySec * 1000 + CRAWL_DELAY_MARGIN_MS : 0)", "prev + delaySec * 1000"],
  ["robots re-read not paced", "ingest/robots.ts", "        const waitSec = await reserve(origin, crawlDelayOf(cached?.policy, o.token));\n", "        const waitSec = null;\n"],
  ["runs allowed back to back", "ingest/publish.ts", "    if (now.getTime() - last < gap) {", "    if (false) {"],
  ["reservations not saved", "ingest/publish.ts", "      await deps.store.save(withReservations(state, due.map((t) => t.key), origins, now, until));\n", ""],
  ["unreadable state tolerated", "ingest/publish.ts", "    if (loaded.problem !== undefined) return", "    if (false) return"],
  ["state not saved after a run", "ingest/publish.ts", "      await deps.store.save(state);\n", ""],
  ["RSS problems ignored", "ingest/publish.ts", "  if (rss.length > 0) return { status: 'kept-last-good'", "  if (false) return { status: 'kept-last-good'"],
  ["RSS eligibility unchecked", "ingest/publish.ts", "      if (!src || !allowed.has(src)) {", "      if (!src) {"],
  ["failed run publishes", "ingest/storage.ts", "  if (outcome.status !== 'publish') return false;", "  if (outcome.status === 'suspended' || outcome.status === 'too-soon') return false;"],
  ["history never pruned", "ingest/storage.ts", "for (const old of all.slice(0, Math.max(0, all.length - this.keep)))", "for (const old of all.slice(0, 0))"],
  ["unsafe paths written", "ingest/storage.ts", "    for (const f of files) if (!SAFE_PATH.test(f.path)) throw", "    for (const f of files) if (false) throw"],
  ["first-seen not published", "shared/wire.ts", "      if (a.publishedAt === null) w.f = a.firstSeenAt;\n", ""],
  ["browser ages undated items from snapshot time", "shared/wire.ts", "firstSeenAt: a.f ?? a.p ?? w.generatedAt,", "firstSeenAt: a.p ?? w.generatedAt,"],
  ["audit ignores Crawl-delay", "tools/collect-local.ts", "      if (gap < delay * 1000) v.push", "      if (false) v.push"],
  ["audit ignores intervals", "tools/collect-local.ts", "      if (gap < f.s.intervalMinutes * 60_000) v.push", "      if (false) v.push"],
  ["audit ignores robots order", "tools/collect-local.ts", "    if (robotsBefore.length === 0 && !(cached && Date.parse(cached.fetchedAt) < e.sentAt)) {", "    if (false) {"],
  ["audit ignores cool-down", "tools/collect-local.ts", "    if (e.status !== 419 && e.status !== 429) continue;", "    continue;"],
  // Production path: Blob storage, kill switch, identity, drill, cron endpoint, security headers
  ["robots-unusable backoff off", "ingest/run.ts", "      if (fr.robotsUnusable) {", "      if (false) {"],
  ["state save unconditional", "ingest/blob.ts", "        ...(this.etag ? { ifMatch: this.etag } : { allowOverwrite: false }),", "        allowOverwrite: true,"],
  ["unchanged files rewritten", "ingest/blob.ts", "      if (manifest[f.path] === h) { this.stats.unchanged++; continue; }\n", ""],
  ["Blob history never pruned", "ingest/blob.ts", "    if (drop.length > 0) {", "    if (false) {"],
  ["control file not required", "ingest/blob.ts", "  if (!r) return { stop: 'no control file: collection is switched off' };", "  if (!r) return { control: { collect: 'on' } };"],
  ["control value not checked", "ingest/blob.ts", "(x as { collect?: unknown }).collect !== 'on'", "false"],
  ["store identity not checked", "ingest/blob.ts", "    if (x.deployment !== expected.deployment || x.project !== expected.project) {", "    if (false) {"],
  ["drill ignored", "ingest/production.ts", "  if (ctl.control.drill === 'keep-last-good') controls.minArticles = LIMITS.minArticles[2];\n", ""],
  ["non-production deployment allowed", "ingest/production.ts", "  if (env.SIGNAL_DEPLOYMENT !== 'production' || env.VERCEL_ENV !== 'production') {", "  if (false) {"],
  ["production ignores SIGNAL_INGEST", "ingest/production.ts", "  if (!controls.ingest) return { status: 'suspended'", "  if (false) return { status: 'suspended'"],
  ["cron secret not checked", "api/collect.ts", "  if (!authorized(request.headers.get('authorization'), process.env.CRON_SECRET)) return json({ error: 'unauthorized' }, 401);\n", ""],
  ["short cron secrets accepted", "api/collect.ts", "  if (!secret || secret.length < 32 || !header) return false;", "  if (!secret || !header) return false;"],
  ["inline scripts allowed wholesale", "tools/security-headers.ts", "    `script-src 'self' ${inlineScriptHashes(indexHtml).join(' ')}`.trim(),", "    \"script-src 'self' 'unsafe-inline'\","],
  ["data origin not checked", "tools/vercel-config.ts", "  if (!/^https:\\/\\/[a-z0-9]+\\.public\\.blob\\.vercel-storage\\.com$/.test(blobBase)) throw", "  if (false) throw"],
  // Operations tools: log retention, rollback, post-deploy checks
  ["ops logs never pruned", "ingest/blob.ts", "      if (day && day < cutoff) old.push(b.pathname);\n", ""],
  ["rollback while collecting", "tools/ops.ts", "  if (ctl.stop === undefined) throw new Error('collection is on", "  if (false) throw new Error('collection is on"],
  ["rollback skips the RSS checks", "tools/ops.ts", "  if (rss.length > 0) throw new Error(`rebuilt feeds fail the RSS checks", "  if (false) throw new Error(`rebuilt feeds fail the RSS checks"],
  ["smoke check passes stale snapshots", "tools/smoke-prod.ts", "    add(`snapshot is under ${opts.maxAgeMin} minutes old`, ageMin <= opts.maxAgeMin,", "    add(`snapshot is under ${opts.maxAgeMin} minutes old`, true,"],
  ["smoke check passes uncleared sources", "tools/smoke-prod.ts", "    add('every headline comes from a source cleared for collection', stray.length === 0,", "    add('every headline comes from a source cleared for collection', true,"],
  ["smoke check passes ineligible feeds", "tools/smoke-prod.ts", "    add('every feed is well-formed RSS 2.0 with only redistributable sources', rss.length === 0,", "    add('every feed is well-formed RSS 2.0 with only redistributable sources', true,"],
  ["interval margin off", "ingest/state.ts", "export const INTERVAL_MARGIN_MS = 1000;", "export const INTERVAL_MARGIN_MS = 0;"],
  ["send time taken before DNS", "ingest/run.ts", "        fr.lastSentAt = Math.max(fr.lastSentAt, sentAt.get(t.url) ?? -Infinity);\n", ""],
  // Conservative robots.txt reading: only a robots file or a same-host 404/410 is an answer
  ["robots: refused file read as no file", "ingest/robots.ts", "  if (r.status >= 400 && r.status < 500) return { kind: 'unreachable', reason: `robots.txt access refused", "  if (r.status >= 400 && r.status < 500) return { kind: 'none', status: r.status }; if (false) return { kind: 'unreachable', reason: `robots.txt access refused"],
  ["robots: HTML page accepted as a robots file", "ingest/robots.ts", "    if (looksLikeHtml(r.body)) return", "    if (false) return"],
  ["robots: missing file on another host accepted", "ingest/robots.ts", "    if (sameHost) return { kind: 'none', status: r.status };", "    return { kind: 'none', status: r.status };"],
  ["robots: audit counts a refused file as an answer", "tools/collect-local.ts", "(st >= 400 && st < 500 && !notFound)", "false"],
  // Path-based launch: radmagelabs.com/signal/ rewrites to the project; Labs requests are monitored
  ["bare /signal/ not served by the project", "tools/vercel-config.ts", "      { source: '/signal/', destination: '/index.html' },\n", ""],
  ["Labs rewrite load never compared", "tools/monitor.ts", "      if (extra > 2 * baseline.labsRewriteRequestsPerDay) {", "      if (false) {"],
  ["Labs daily usage compared on a short window", "tools/monitor.ts", "    if (hours < 24) { /* reported, not compared */ }", "    if (false) { /* reported, not compared */ }"],
  ["Labs cache miss not flagged", "tools/monitor.ts", "  if (labs.cached === false) {", "  if (false) {"],
  ["weak ETag passed to conditional writes", "ingest/blob.ts", "etag: strongEtag(r.blob.etag)", "etag: r.blob.etag"],
  ["Labs usage counts every service as requests", "tools/monitor.ts", "filter((x) => x.product === 'edgeRequest')", "filter(() => true)"],
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
