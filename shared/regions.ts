// A small gazetteer used to place general "world" headlines into a regional list when the
// feed itself does not say which region a story belongs to. Matching is on whole words of
// the normalized headline; the first region with the most hits wins; no hit means the
// story stays in the general world list.
import type { Subsection } from './types.ts';
import { normalizeTitle } from './cluster.ts';
import { REGIONS, US_WORDS, US_PHRASES } from './places.ts';



const TABLE: [Subsection, Set<string>, string[]][] = REGIONS.map(([sub]) => [sub, new Set<string>(), []]);
// Multi-word names ("hong kong", "west bank") are kept as phrases; the rest as single words.
const PHRASES = ['hong kong', 'south africa', 'sri lanka', 'tel aviv', 'west bank', 'abu dhabi', 'buenos aires', 'kuala lumpur', 'addis ababa', 'new zealand', 'el salvador'];
REGIONS.forEach(([, words], i) => {
  const [, single, multi] = TABLE[i]!;
  let rest = ' ' + words + ' ';
  for (const p of PHRASES) {
    if (rest.includes(' ' + p + ' ')) { multi.push(p); rest = rest.replace(' ' + p + ' ', ' '); }
  }
  for (const w of rest.split(/\s+/)) if (w) single.add(w);
});

export function regionOf(title: string): Subsection | null {
  const norm = ' ' + normalizeTitle(title) + ' ';
  const words = norm.trim().split(' ');
  let best: Subsection | null = null;
  let bestHits = 0;
  for (const [sub, single, multi] of TABLE) {
    let hits = 0;
    for (const w of words) if (single.has(w)) hits++;
    for (const p of multi) if (norm.includes(' ' + p + ' ')) hits += 2;
    if (hits > bestHits) { best = sub; bestHits = hits; }
  }
  return best;
}

// U.S. domestic markers: states, large cities and federal institutions. Used only for
// headlines that arrived through a general world feed and matched no other region.



export function isUsDomestic(title: string): boolean {
  const norm = ' ' + normalizeTitle(title) + ' ';
  if (US_PHRASES.some((p) => norm.includes(' ' + p + ' '))) return true;
  return norm.trim().split(' ').some((w) => US_WORDS.has(w));
}
