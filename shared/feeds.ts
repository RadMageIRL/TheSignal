// The catalog of The Signal's own outgoing RSS feeds. One list drives the feed generator, the
// RSS directory page, the section icons and the autodiscovery links in index.html.
import type { SectionId } from './types.ts';
import { IDENTITY } from './identity.ts';

export type FeedScope = 'all' | 'section' | 'trending' | 'perspectives';

export interface FeedSpec {
  id: string;
  /** Path under the site root, e.g. "rss/us.xml" -> https://radmagelabs.com/signal/rss/us.xml */
  path: string;
  scope: FeedScope;
  section?: SectionId;
  title: string;
  description: string;
  /** Where the matching part of the page lives (hash anchor). */
  anchor: string;
}

export const FEED_SPECS: FeedSpec[] = [
  { id: 'all', path: 'rss.xml', scope: 'all', title: 'All headlines', anchor: '',
    description: 'Every headline in the current snapshot whose publisher allows redistribution, newest first.' },
  { id: 'us', path: 'rss/us.xml', scope: 'section', section: 'us', title: 'U.S. & Politics', anchor: '#us',
    description: 'National, Washington, law and domestic economy headlines.' },
  { id: 'world', path: 'rss/world.xml', scope: 'section', section: 'world', title: 'World News', anchor: '#world',
    description: 'Headlines from newsrooms around the world, by region.' },
  { id: 'markets', path: 'rss/markets.xml', scope: 'section', section: 'markets', title: 'Markets & Technology', anchor: '#markets',
    description: 'Markets, central banks, technology and science.' },
  { id: 'alternative', path: 'rss/alternative.xml', scope: 'section', section: 'outside', title: 'Outside the Mainstream', anchor: '#outside',
    description: 'Independent and alternative outlets from across the spectrum. Inclusion is not endorsement.' },
  { id: 'airwaves', path: 'rss/airwaves.xml', scope: 'section', section: 'airwaves', title: 'The Airwaves', anchor: '#airwaves',
    description: 'Latest podcast episodes, linked to each show.' },
  { id: 'pulse', path: 'rss/pulse.xml', scope: 'section', section: 'pulse', title: "The People's Pulse", anchor: '#pulse',
    description: 'What public communities are sharing and reading. Activity is not verification.' },
  { id: 'trending', path: 'rss/trending.xml', scope: 'trending', title: 'Most covered', anchor: '#trending',
    description: 'The stories carried by the most outlets in the last six hours.' },
  { id: 'perspectives', path: 'rss/perspectives.xml', scope: 'perspectives', title: 'Global Perspectives', anchor: '#perspectives',
    description: 'Stories covered by outlets in at least three countries.' },
];

export const FEED_LIMITS = {
  /** Items per section, trending or perspectives feed. */
  maxItems: 60,
  /** Items in the all-headlines feed. */
  maxItemsAll: 100,
  /** Hard cap on one feed document, in bytes of UTF-8. Oldest items are dropped to fit. */
  maxBytes: 200_000,
  /** Polling hint for readers, in minutes (RSS <ttl>). */
  ttlMinutes: 30,
} as const;

export function feedUrl(spec: Pick<FeedSpec, 'path'>): string {
  return IDENTITY.website + spec.path;
}

export function feedForSection(section: SectionId): FeedSpec | undefined {
  return FEED_SPECS.find((f) => f.scope === 'section' && f.section === section);
}
