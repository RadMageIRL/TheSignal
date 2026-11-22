// Headline search over the current snapshot, with simple filters. Runs entirely in the browser.
import type { Article, SectionId } from '../../shared/types.ts';
import { normalizeTitle } from '../../shared/cluster.ts';
import { countryName } from '../../shared/countries.ts';
import type { SourceMeta, View } from './data.ts';

export type Within = 'any' | '6h' | '24h' | '48h';
export type SortOrder = 'newest' | 'coverage';

export interface SearchFilters {
  section: SectionId | 'all';
  source: string; // source id or 'all'
  country: string; // ISO code or 'all'
  within: Within;
  sort: SortOrder;
}

export const DEFAULT_FILTERS: SearchFilters = { section: 'all', source: 'all', country: 'all', within: 'any', sort: 'newest' };

const WITHIN_MS: Record<Within, number> = { any: Infinity, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '48h': 48 * 3600_000 };

export interface Facet { value: string; label: string; count: number }

export interface SearchResult {
  results: Article[];
  /** Matches for the query before filters are applied. */
  matched: number;
  /** Matches after filters, before the display limit. */
  total: number;
  facets: { sections: Facet[]; sources: Facet[]; countries: Facet[] };
}

export const RESULT_LIMIT = 100;

export function queryTerms(q: string): string[] {
  return normalizeTitle(q).split(' ').filter((t) => t.length > 1).slice(0, 12);
}

function facet(items: Article[], key: (a: Article) => string, label: (v: string) => string): Facet[] {
  const n = new Map<string, number>();
  for (const a of items) n.set(key(a), (n.get(key(a)) ?? 0) + 1);
  return [...n.entries()].map(([value, count]) => ({ value, label: label(value), count }))
    .sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
}

export function searchArticles(view: View, sources: Map<string, SourceMeta>, query: string, f: SearchFilters, nowMs: number,
  sectionLabel: (s: SectionId) => string = (s) => s): SearchResult {
  const terms = queryTerms(query);
  const empty = { results: [], matched: 0, total: 0, facets: { sections: [], sources: [], countries: [] } };
  if (terms.length === 0) return empty;
  const matched: Article[] = [];
  for (const a of view.articles.values()) {
    const s = sources.get(a.sourceId);
    const hay = ' ' + normalizeTitle(`${a.title} ${s?.name ?? ''} ${countryName(a.country)}`) + ' ';
    if (terms.every((t) => hay.includes(t))) matched.push(a);
  }
  const time = (a: Article) => Date.parse(a.publishedAt ?? a.fetchedAt);
  const within = WITHIN_MS[f.within];
  const filtered = matched.filter((a) =>
    (f.section === 'all' || a.section === f.section)
    && (f.source === 'all' || a.sourceId === f.source)
    && (f.country === 'all' || a.country === f.country)
    && (within === Infinity || nowMs - time(a) <= within));
  const outlets = (a: Article) => {
    const cid = view.clusterOf.get(a.id);
    return cid ? (view.clusters.get(cid)?.sourceCount ?? 1) : 1;
  };
  filtered.sort((x, y) => (f.sort === 'coverage' ? outlets(y) - outlets(x) : 0) || time(y) - time(x) || (x.id < y.id ? -1 : 1));
  return {
    results: filtered.slice(0, RESULT_LIMIT),
    matched: matched.length,
    total: filtered.length,
    facets: {
      sections: facet(matched, (a) => a.section, (v) => sectionLabel(v as SectionId)),
      sources: facet(matched, (a) => a.sourceId, (v) => sources.get(v)?.name ?? v),
      countries: facet(matched, (a) => a.country, countryName),
    },
  };
}
