// Loads the published snapshot and turns it into what the page renders. When a reader has
// turned sources off, the same ranking and layout rules run again in the browser.
import type { Article, Cluster, Snapshot } from '../../shared/types.ts';
import { decodeArticles, decodeClusters, type WireSnapshot } from '../../shared/wire.ts';
import { parseWire } from '../../shared/schema.ts';
import { buildLayout, type PageLayout } from '../../shared/layout.ts';
import { primaryLanguage } from '../../shared/languages.ts';
import type { Prefs } from './prefs.ts';

export type SourceMeta = Snapshot['sources'][number];

export interface SiteData {
  wire: WireSnapshot;
  sources: Map<string, SourceMeta>;
  articles: Map<string, Article>;
  baseClusters: Cluster[];
}

export interface View extends PageLayout {
  articles: Map<string, Article>;
}

export async function loadSnapshot(signal?: AbortSignal): Promise<SiteData> {
  const res = await fetch('data/snapshot.json', { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  // Everything in the snapshot came from outside feeds: check it and drop what fails.
  const { wire } = parseWire(await res.json());
  const articles = decodeArticles(wire);
  return {
    wire,
    sources: new Map(wire.sources.map((s) => [s.id, s])),
    articles,
    baseClusters: decodeClusters(wire, articles),
  };
}

export function buildView(d: SiteData, disabled: Set<string>): View {
  const nowMs = Date.parse(d.wire.generatedAt);
  if (disabled.size === 0) {
    // Default page: exactly the layout the collector published.
    const page = buildLayout(d.articles, d.baseClusters, nowMs);
    return {
      ...page,
      leadClusterId: d.wire.leadClusterId,
      layout: d.wire.layout,
      perspectives: d.wire.perspectives,
      trending: d.wire.trending,
      breaking: d.wire.breaking,
      articles: d.articles,
    };
  }
  const visible = new Map([...d.articles].filter(([, a]) => !disabled.has(a.sourceId)));
  return { ...buildLayout(visible, d.baseClusters, nowMs), articles: visible };
}

/** Sources left off the page: the ones the reader turned off, and every source in a language the reader hid. */
export function offSources(d: Pick<SiteData, 'sources'>, p: Pick<Prefs, 'disabledSources' | 'hiddenLanguages'>): Set<string> {
  const off = new Set(p.disabledSources);
  if (p.hiddenLanguages.length > 0) {
    const hide = new Set(p.hiddenLanguages);
    for (const s of d.sources.values()) if (hide.has(primaryLanguage(s.language))) off.add(s.id);
  }
  return off;
}

export function clusterArticles(view: View, id: string): Article[] {
  const c = view.clusters.get(id);
  if (!c) return [];
  return c.articleIds.map((a) => view.articles.get(a)).filter((a): a is Article => !!a);
}
