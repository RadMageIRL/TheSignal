import type { FeedSpec } from '../../shared/feeds.ts';

const ARCS = 'M5 11a8 8 0 0 1 8 8M5 4a15 15 0 0 1 15 15';

export function RssIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d={ARCS} />
      <circle cx="6" cy="18" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A small, quiet link to one feed's entry in the RSS directory. */
export function RssLink({ spec }: { spec: FeedSpec }) {
  return (
    <a className="rss-link" href={`#/feeds?feed=${spec.id}`} aria-label={`RSS feed: ${spec.title}`} title={`RSS feed: ${spec.title}`}>
      <RssIcon />
    </a>
  );
}
