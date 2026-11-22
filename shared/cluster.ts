// Deterministic, conservative story clustering.
//
// Two headlines join the same story only when they share at least two distinctive words
// (rare across the current snapshot) AND their IDF-weighted similarity clears a threshold,
// AND they were published within a time window. A candidate must also agree with the
// cluster as a whole (average similarity), which stops A~B~C chains from merging unrelated
// stories. Wrongly merging two events is worse than showing a duplicate, so every
// threshold leans toward "separate".

import type { Article, Cluster } from './types.ts';
import { PLACE_TOKENS, canonicalPlace } from './places.ts';
import { stem } from './stem.ts';

const STOP = new Set((
  'a an the and or but nor so yet of to in on at by for from with without into onto over under about above below after before ' +
  'during since until amid among between against through via per as is are was were be been being am do does did done has have had ' +
  'having will would shall should can could may might must not no yes it its this that these those there here their them they he she ' +
  'his her him we our you your i me my who whom whose what which when where why how than then too very just also only more most less ' +
  'least much many some any all each every other another such same own up down out off again further once new news says said say ' +
  'saying tells told report reports reported latest live update updates breaking watch video photos photo analysis opinion explainer ' +
  'week weeks day days today tonight year years month months first last next now get gets got make makes made take takes took amid ' +
  'one two three four five six seven eight nine ten us via ' +
  'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec ' +
  'monday tuesday wednesday thursday friday saturday sunday'
).split(/\s+/));

const BS = String.fromCharCode(92);
const COMBINING = new RegExp('[' + BS + 'u0300-' + BS + 'u036f]', 'g');
const APOSTROPHES = new RegExp('[' + String.fromCharCode(39) + '`' + BS + 'u2018' + BS + 'u2019]', 'g');

// Agency update markers such as "(LEAD)", "(2nd LD)", "(URGENT)", "UPDATE 2:" mark revisions
// of one report, not new reports.
const MARKERS = /^\s*(\((?:lead|\d+(?:st|nd|rd|th)\s+ld|urgent|update\s*\d*|corrected|correction|news focus|recasts?|adds?[^)]*)\)\s*|(?:update|updated|corrected)\s*\d*\s*:\s*|live\s*:\s*|watch\s*:\s*|breaking\s*:\s*)+/i;

export function stripMarkers(t: string): string {
  return t.replace(MARKERS, '');
}

export function normalizeTitle(t: string): string {
  return stripMarkers(t).toLowerCase().normalize('NFKD').replace(COMBINING, '').replace(APOSTROPHES, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}


export function tokenize(title: string): string[] {
  const out = new Set<string>();
  for (const raw of normalizeTitle(title).split(' ')) {
    if (!raw || STOP.has(raw)) continue;
    if (/^\d+$/.test(raw)) {
      // Day numbers and years describe when, not what; larger numbers (death tolls,
      // vote counts) do help tell stories apart.
      const n = Number(raw);
      if (raw.length >= 2 && n > 31 && !(n >= 1990 && n <= 2099)) out.add(raw);
      continue;
    }
    if (raw.length < 3) continue;
    out.add(stem(raw));
  }
  return [...out];
}

export interface ClusterOptions {
  windowHours: number;
  /** A token is "distinctive" when it appears in at most this share of articles (and at least once elsewhere). */
  rareShare: number;
  /** ...but never fewer than this many articles, so a widely covered story keeps its key words. */
  rareFloor: number;
  minSharedRare: number;
  pairThreshold: number;
  clusterThreshold: number;
  maxClusterSize: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  windowHours: 36,
  rareShare: 0.02,
  rareFloor: 10,
  minSharedRare: 2,
  pairThreshold: 0.34,
  clusterThreshold: 0.26,
  maxClusterSize: 40,
};

/** Two headlines that each name places, but no place in common, are about different events. */
export function placesConflict(a: string[], b: string[]): boolean {
  const pa = a.filter((t) => PLACE_TOKENS.has(t)).map(canonicalPlace);
  if (pa.length === 0) return false;
  const pb = b.filter((t) => PLACE_TOKENS.has(t)).map(canonicalPlace);
  if (pb.length === 0) return false;
  return !pa.some((t) => pb.includes(t));
}

interface Doc { a: Article; t: number; tokens: string[]; weight: Map<string, number>; norm: number; key: string }

function timeOf(a: Article): number {
  return Date.parse(a.publishedAt ?? a.firstSeenAt);
}

export function similarity(x: Doc, y: Doc): number {
  if (placesConflict(x.tokens, y.tokens)) return 0;
  let shared = 0;
  const [small, big] = x.tokens.length <= y.tokens.length ? [x, y] : [y, x];
  for (const tok of small.tokens) if (big.weight.has(tok)) shared += small.weight.get(tok)!;
  const union = x.norm + y.norm - shared;
  return union > 0 ? shared / union : 0;
}

/**
 * Distinct originating reports in a set of articles. An origin is a wire service (when the
 * item names one) or a publisher; publishers running an identical headline are treated as
 * one origin, because that is what syndicated copy looks like. Several articles from one
 * publisher, or from outlets of one editorial network, never count as independent corroboration.
 */
export function countOrigins(arts: Pick<Article, 'sourceId' | 'wire' | 'title' | 'network'>[]): number {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const add = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
  const union = (x: string, y: string) => { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(ry, rx); };
  const byTitle = new Map<string, string>();
  for (const a of arts) {
    const k = a.wire ? 'wire:' + a.wire.toLowerCase() : a.network ? 'net:' + a.network : 'src:' + a.sourceId;
    add(k);
    const t = normalizeTitle(a.title).split(' ').slice(0, 14).join(' ');
    const prev = byTitle.get(t);
    if (prev) union(prev, k); else byTitle.set(t, k);
  }
  const roots = new Set<string>();
  for (const k of parent.keys()) roots.add(find(k));
  return roots.size;
}

/** Codes that name a group of countries rather than one: they never add to a country count. */
export const NOT_A_COUNTRY = new Set(['INT', 'EU']);

/** Distinct countries among a story's outlets. Multinational (INT) and EU outlets are not counted. */
export function countryCountOf(arts: Pick<Article, 'country'>[]): number {
  return new Set(arts.map((a) => a.country).filter((c) => !NOT_A_COUNTRY.has(c))).size;
}

export interface CopyNote {
  /** The item credits a wire service that another outlet in the same story also carries. */
  wire?: string;
  /** The item's headline is word for word the same as an earlier item from a different outlet. */
  sameAs?: string;
}

type CopyInput = Pick<Article, 'id' | 'sourceId' | 'wire' | 'title' | 'publishedAt' | 'firstSeenAt'>;

/**
 * What the metadata identifies as shared copy inside one story. An item without a note is not
 * thereby shown to be an independent report: feeds rarely say where their copy came from.
 */
export function copyNotes(arts: CopyInput[]): Map<string, CopyNote> {
  const notes = new Map<string, CopyNote>();
  const wireOutlets = new Map<string, Set<string>>();
  for (const a of arts) {
    if (!a.wire) continue;
    const k = a.wire.toLowerCase();
    let s = wireOutlets.get(k);
    if (!s) wireOutlets.set(k, (s = new Set()));
    s.add(a.sourceId);
  }
  const ordered = [...arts].sort((x, y) => timeOf(x as Article) - timeOf(y as Article) || (x.id < y.id ? -1 : 1));
  const firstByTitle = new Map<string, CopyInput>();
  for (const a of ordered) {
    const note: CopyNote = {};
    if (a.wire && (wireOutlets.get(a.wire.toLowerCase())?.size ?? 0) >= 2) note.wire = a.wire;
    const key = normalizeTitle(a.title).split(' ').slice(0, 14).join(' ');
    const first = firstByTitle.get(key);
    if (!first) firstByTitle.set(key, a);
    else if (first.sourceId !== a.sourceId) note.sameAs = first.id;
    if (note.wire || note.sameAs) notes.set(a.id, note);
  }
  return notes;
}

/** Distinct outlets in a story with at least one item identified as shared wire or identical copy. */
export function sharedCopyOutlets(arts: CopyInput[]): number {
  const notes = copyNotes(arts);
  return new Set(arts.filter((a) => notes.has(a.id)).map((a) => a.sourceId)).size;
}

export function clusterArticles(articles: Article[], opts: ClusterOptions = DEFAULT_CLUSTER_OPTIONS): Cluster[] {
  const n = articles.length;
  const df = new Map<string, number>();
  const tokenLists = articles.map((a) => tokenize(a.title));
  for (const toks of tokenLists) for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  const rareMax = Math.max(opts.rareFloor, Math.floor(n * opts.rareShare));
  const idf = (t: string) => Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5));
  const isRare = (t: string) => { const d = df.get(t) ?? 0; return d >= 2 && d <= rareMax; };

  const docs: Doc[] = articles.map((a, i) => {
    const tokens = tokenLists[i]!;
    const weight = new Map(tokens.map((t) => [t, idf(t)] as const));
    let norm = 0;
    for (const w of weight.values()) norm += w;
    return { a, t: timeOf(a), tokens, weight, norm, key: normalizeTitle(a.title) };
  });
  // Oldest first, ties by id: the same input always yields the same clusters.
  const order = docs.map((_, i) => i).sort((i, j) => docs[i]!.t - docs[j]!.t || (docs[i]!.a.id < docs[j]!.a.id ? -1 : 1));

  const members: number[][] = [];
  const clusterOf = new Int32Array(n).fill(-1);
  const index = new Map<string, Set<number>>(); // rare token -> cluster ids
  const windowMs = opts.windowHours * 3600_000;

  for (const i of order) {
    const d = docs[i]!;
    const rare = d.tokens.filter(isRare);
    const candidates = new Map<number, number>();
    for (const t of rare) for (const c of index.get(t) ?? []) candidates.set(c, (candidates.get(c) ?? 0) + 1);
    let best = -1;
    let bestScore = 0;
    for (const [c, sharedRare] of candidates) {
      if (sharedRare < opts.minSharedRare) continue;
      const mem = members[c]!;
      if (mem.length >= opts.maxClusterSize) continue;
      let sum = 0;
      let max = 0;
      let inWindow = 0;
      const sample = mem.slice(-12);
      for (const m of sample) {
        const o = docs[m]!;
        if (Math.abs(o.t - d.t) > windowMs) continue;
        inWindow++;
        const s = similarity(d, o);
        sum += s;
        if (s > max) max = s;
      }
      if (inWindow === 0) continue;
      const avg = sum / sample.length;
      if (max >= opts.pairThreshold && avg >= opts.clusterThreshold && avg > bestScore) {
        best = c;
        bestScore = avg;
      }
    }
    if (best < 0) {
      best = members.length;
      members.push([]);
    }
    members[best]!.push(i);
    clusterOf[i] = best;
    for (const t of rare) {
      let s = index.get(t);
      if (!s) index.set(t, (s = new Set()));
      s.add(best);
    }
  }

  return members.map((mem) => {
    const arts = mem.map((m) => docs[m]!);
    const sources = new Set(arts.map((x) => x.a.sourceId));
    const times = arts.map((x) => x.t);
    const firstSeen = new Date(Math.min(...times)).toISOString();
    const lastSeen = new Date(Math.max(...times)).toISOString();
    const lead = pickLead(arts.map((x) => x.a));
    return {
      id: 'c_' + lead.id,
      articleIds: arts.map((x) => x.a.id),
      leadArticleId: lead.id,
      sourceCount: sources.size,
      countryCount: countryCountOf(arts.map((x) => x.a)),
      originCount: countOrigins(arts.map((x) => x.a)),
      firstSeen,
      lastSeen,
      score: 0,
    };
  });
}

const LEAD_TYPE_ORDER: Record<string, number> = {
  reporting: 0, wire: 1, official: 2, investigation: 3, mixed: 4, commentary: 5, opinion: 6,
  podcast: 7, video: 8, community: 9,
};

/** The lead headline is the earliest straight-news report; commentary only leads if nothing else does. */
export function pickLead(arts: Article[]): Article {
  return [...arts].sort((x, y) =>
    (LEAD_TYPE_ORDER[x.contentType] ?? 9) - (LEAD_TYPE_ORDER[y.contentType] ?? 9)
    || timeOf(x) - timeOf(y)
    || (x.id < y.id ? -1 : 1))[0]!;
}
