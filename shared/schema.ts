// Runtime checks for the published snapshot (wire format v1). The collector runs the strict
// check before publishing; the browser runs the lenient parse on whatever it downloads, dropping
// malformed or unsafe records instead of rendering them. Feed text is untrusted throughout.
import type { WireArticle, WireSnapshot } from './wire.ts';
import type { PublicSource, SectionId, Subsection } from './types.ts';
import { SECTION_SUBS } from './layout.ts';
import { safeLink } from './url.ts';

export const SCHEMA_LIMITS = {
  maxSources: 1000,
  maxArticles: 20_000,
  maxClusters: 20_000,
  maxTitle: 400,
  maxName: 200,
} as const;

const SECTIONS = Object.keys(SECTION_SUBS) as SectionId[];
const SUBS = new Set<string>(Object.values(SECTION_SUBS).flat());
const TYPES = new Set(['reporting', 'wire', 'opinion', 'commentary', 'investigation', 'official', 'podcast', 'video', 'community', 'mixed']);
const AFFS = new Set(['private', 'public-broadcaster', 'state', 'government', 'intergovernmental', 'nonprofit', 'independent', 'cooperative', 'community', 'unknown']);

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown, max = 2048): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const isIso = (x: unknown): x is string => typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x));
const isCount = (x: unknown): boolean => x === undefined || (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1e12);

function sourceProblem(s: unknown): string | null {
  if (!isObj(s)) return 'not an object';
  if (!isStr(s.id, 80)) return 'bad id';
  if (!isStr(s.name, SCHEMA_LIMITS.maxName)) return 'bad name';
  if (!safeLink(s.homepage)) return 'unsafe homepage';
  if (!isStr(s.country, 3)) return 'bad country';
  if (!SECTIONS.includes(s.section as SectionId)) return 'bad section';
  if (!TYPES.has(String(s.contentType))) return 'bad content type';
  if (!AFFS.has(String(s.affiliation))) return 'bad affiliation';
  if (s.syndicate !== undefined && typeof s.syndicate !== 'boolean') return 'bad syndicate flag';
  if (s.notice !== undefined && !isStr(s.notice, 400)) return 'bad notice';
  if (s.network !== undefined && !isStr(s.network, 60)) return 'bad network';
  return null;
}

function articleProblem(a: unknown, sources: Set<string>): string | null {
  if (!isObj(a)) return 'not an object';
  if (!isStr(a.i, 64)) return 'bad id';
  if (!isStr(a.s, 80) || !sources.has(a.s)) return 'unknown source';
  if (!isStr(a.t, SCHEMA_LIMITS.maxTitle) || !a.t.trim()) return 'bad title';
  if (!safeLink(a.u)) return 'unsafe link';
  if (a.p !== null && !isIso(a.p)) return 'bad date';
  if (a.f !== undefined && !isIso(a.f)) return 'bad first-seen time';
  if (!SUBS.has(String(a.b))) return 'bad list';
  if (a.x !== undefined && !safeLink(a.x)) return 'unsafe discussion link';
  if (!isCount(a.d) || !isCount(a.n) || !isCount(a.c)) return 'bad count';
  for (const k of ['w', 'g', 'o'] as const) if (a[k] !== undefined && !isStr(a[k], 200)) return `bad ${k}`;
  return null;
}

/** Every problem in a snapshot. The collector publishes only when this is empty. */
export function validateWire(w: unknown): string[] {
  const out: string[] = [];
  if (!isObj(w)) return ['snapshot is not an object'];
  if (w.v !== 1) out.push('unsupported version');
  if (w.mode !== 'live' && w.mode !== 'prototype') out.push('bad mode');
  if (!isIso(w.generatedAt)) out.push('bad generatedAt');
  if (w.nextUpdateAt !== null && !isIso(w.nextUpdateAt)) out.push('bad nextUpdateAt');
  if (!Array.isArray(w.sources) || w.sources.length > SCHEMA_LIMITS.maxSources) return [...out, 'bad sources list'];
  if (!Array.isArray(w.articles) || w.articles.length > SCHEMA_LIMITS.maxArticles) return [...out, 'bad articles list'];
  if (!Array.isArray(w.clusters) || w.clusters.length > SCHEMA_LIMITS.maxClusters) return [...out, 'bad clusters list'];
  const srcIds = new Set<string>();
  w.sources.forEach((s, i) => {
    const p = sourceProblem(s);
    if (p) out.push(`source ${i}: ${p}`);
    else srcIds.add((s as PublicSource).id);
  });
  const artIds = new Set<string>();
  w.articles.forEach((a, i) => {
    const p = articleProblem(a, srcIds);
    if (p) out.push(`article ${i}: ${p}`);
    else if (artIds.has((a as WireArticle).i)) out.push(`article ${i}: duplicate id`);
    else artIds.add((a as WireArticle).i);
  });
  w.clusters.forEach((c, i) => {
    if (!isObj(c) || !isStr(c.i, 80) || !Array.isArray(c.a) || !isIso(c.f) || !isIso(c.l)) out.push(`cluster ${i}: malformed`);
    else if (c.a.some((id) => !artIds.has(String(id)))) out.push(`cluster ${i}: refers to a missing article`);
  });
  if (!isObj(w.layout)) out.push('bad layout');
  if (!isObj(w.stats)) out.push('bad stats');
  return out;
}

/**
 * Lenient parse for the browser: throws when the document as a whole is unusable, otherwise
 * drops the records that fail their checks and reports how many were dropped.
 */
export function parseWire(input: unknown): { wire: WireSnapshot; dropped: number } {
  if (!isObj(input) || input.v !== 1) throw new Error('unsupported snapshot');
  if (!isIso(input.generatedAt) || !Array.isArray(input.sources) || !Array.isArray(input.articles) || !Array.isArray(input.clusters)) {
    throw new Error('malformed snapshot');
  }
  if (input.sources.length > SCHEMA_LIMITS.maxSources || input.articles.length > SCHEMA_LIMITS.maxArticles || input.clusters.length > SCHEMA_LIMITS.maxClusters) {
    throw new Error('snapshot over size limits');
  }
  let dropped = 0;
  const sources = (input.sources as unknown[]).filter((s) => { const ok = !sourceProblem(s); if (!ok) dropped++; return ok; }) as PublicSource[];
  const srcIds = new Set(sources.map((s) => s.id));
  const seen = new Set<string>();
  const articles = (input.articles as unknown[]).filter((a) => {
    const ok = !articleProblem(a, srcIds) && !seen.has((a as WireArticle).i);
    if (ok) seen.add((a as WireArticle).i); else dropped++;
    return ok;
  }) as WireArticle[];
  const clusters = (input.clusters as unknown[])
    .filter((c): c is WireSnapshot['clusters'][number] => isObj(c) && isStr(c.i, 80) && Array.isArray(c.a) && isIso(c.f) && isIso(c.l))
    .map((c) => ({ ...c, a: c.a.filter((id) => seen.has(String(id))) }));
  const layout = isObj(input.layout) ? (input.layout as WireSnapshot['layout']) : ({} as WireSnapshot['layout']);
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
  const cleanLayout = {} as WireSnapshot['layout'];
  for (const s of SECTIONS) {
    cleanLayout[s] = {};
    const lists = isObj(layout[s]) ? (layout[s] as Record<string, unknown>) : {};
    for (const sub of SECTION_SUBS[s]) cleanLayout[s][sub as Subsection] = ids(lists[sub]);
  }
  const wire: WireSnapshot = {
    v: 1,
    mode: input.mode === 'live' ? 'live' : 'prototype',
    generatedAt: input.generatedAt,
    nextUpdateAt: isIso(input.nextUpdateAt) ? input.nextUpdateAt : null,
    sources,
    articles,
    clusters,
    leadClusterId: typeof input.leadClusterId === 'string' ? input.leadClusterId : null,
    layout: cleanLayout,
    perspectives: ids(input.perspectives),
    trending: ids(input.trending),
    breaking: typeof input.breaking === 'string' ? input.breaking : null,
    stats: (isObj(input.stats) ? input.stats : {}) as WireSnapshot['stats'],
  };
  return { wire, dropped };
}
