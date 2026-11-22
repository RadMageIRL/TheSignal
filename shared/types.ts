// Shared data model for the source registry, normalized articles and the public snapshot.
// Everything in a snapshot is untrusted text that came from a feed and was sanitized at
// ingest; the frontend still renders it only as text (never as HTML).

export type SectionId = 'us' | 'world' | 'markets' | 'outside' | 'airwaves' | 'pulse';

export type Subsection =
  // U.S. & Politics
  | 'national' | 'washington' | 'law' | 'economy'
  // World News
  | 'europe' | 'mideast' | 'asia' | 'africa-americas' | 'world-general'
  // Markets & Technology
  | 'global-markets' | 'crypto' | 'tech' | 'science'
  // Outside the Mainstream
  | 'alternative' | 'independent' | 'investigations' | 'commentary'
  // The Airwaves
  | 'podcasts' | 'interviews' | 'video'
  // The People's Pulse
  | 'discussions' | 'trends' | 'reading';

export type ContentType =
  | 'reporting' | 'wire' | 'opinion' | 'commentary' | 'investigation'
  | 'official' | 'podcast' | 'video' | 'community' | 'mixed';

export type SourceStatus = 'READY' | 'RESEARCH' | 'CONDITIONAL' | 'DEFERRED' | 'UNAVAILABLE';

export type Affiliation =
  | 'private' | 'public-broadcaster' | 'state' | 'government' | 'intergovernmental' | 'nonprofit'
  | 'independent' | 'cooperative' | 'community' | 'unknown';

export type FeedKind = 'rss' | 'podcast' | 'hn-rss' | 'mastodon-links' | 'wikipedia-top' | 'json-feed';

export interface FeedEndpoint {
  url: string;
  kind: FeedKind;
  /** Set when the feed carries another section's stories than its source's usual one. */
  section?: SectionId;
  subsection: Subsection;
  /** Extra hosts a redirect from this feed may land on (SSRF allowlist). */
  redirectHosts?: string[];
}

/** What a publisher's terms say about one kind of use: yes, no, or not established. */
export type Permission = 'yes' | 'no' | 'unknown';

/**
 * Separate permissions, because showing a headline on this site does not by itself permit
 * redistributing it through The Signal's own RSS feeds.
 * - display: headline, publisher, time and link on the public website
 * - syndication: the same, redistributed through The Signal's outgoing RSS feeds
 * - excerpt: a summary or excerpt (never shown today)
 * - images: the publisher's images (never shown today)
 */
export interface SourceRights {
  display: Permission;
  syndication: Permission;
  excerpt: Permission;
  images: Permission;
}

export interface SourceEntry {
  id: string;
  name: string;
  homepage: string;
  country: string; // ISO 3166-1 alpha-2, 'EU', or 'INT' for multinational
  region: string;
  language: string; // BCP 47
  section: SectionId;
  contentType: ContentType;
  affiliation: Affiliation;
  ownership: string;
  intervalMinutes: number;
  feeds: FeedEndpoint[];
  status: SourceStatus;
  /** Why the source has its status, in neutral public wording. */
  statusNote: string;
  /** Checks that must pass before the source may be enabled. */
  gates: string[];
  termsUrl: string;
  attribution: string;
  /** Exact attribution or licence statement that must accompany the source's headlines. */
  notice?: string;
  rights: SourceRights;
  /** Conditions that apply to any use, e.g. items that must be filtered out. */
  restrictions: string;
  /** Items to leave out: by credited wire service, or by URL path prefix. */
  filters?: { dropWires?: string[]; excludePaths?: string[] };
  /** Editorial network whose outlets republish one another (e.g. editions of one publisher). */
  network?: string;
  /** Collected in production. Only READY sources with display permission may be enabled. */
  enabled: boolean;
  /** Date (YYYY-MM-DD) the status and rights were last reviewed. */
  reviewed: string;
}

/** The part of a registry entry that is published with a snapshot. */
export type PublicSource = Pick<SourceEntry, 'id' | 'name' | 'homepage' | 'country' | 'region' | 'language' | 'section' | 'contentType' | 'affiliation' | 'ownership' | 'attribution' | 'notice' | 'network'> & {
  /** The source's headlines may appear in The Signal's outgoing RSS feeds. */
  syndicate?: boolean;
};

export interface PodcastMeta {
  show: string;
  durationSec?: number;
  guest?: string;
}

export interface CommunityMeta {
  platform: string; // e.g. "Hacker News"
  origin: string; // community or server, e.g. "news.ycombinator.com", "mastodon.social"
  /** Platform activity counts, shown as platform activity only, never as verification. */
  points?: number;
  comments?: number;
  discussionUrl?: string;
}

export interface Article {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  /**
   * Publication time as the feed gave it, kept only when it is believable: not in the future and
   * not later than the moment The Signal first saw the item. Otherwise null.
   */
  publishedAt: string | null;
  /**
   * When The Signal first saw the item in any feed, kept across runs. Undated items are aged by
   * this, so an unchanged undated item does not look new on every run.
   */
  firstSeenAt: string;
  section: SectionId;
  subsection: Subsection;
  contentType: ContentType;
  country: string;
  language: string;
  /** Wire service named in the item, when the feed says so (used for shared-copy counting). */
  wire?: string;
  /** The source's editorial network, if any (its outlets count as one origin). */
  network?: string;
  podcast?: PodcastMeta;
  community?: CommunityMeta;
}

export interface Cluster {
  id: string;
  articleIds: string[];
  leadArticleId: string;
  sourceCount: number;
  countryCount: number;
  /**
   * Distinct origins after collapsing what the metadata identifies as shared copy: items that
   * credit the same wire service count once, and word-for-word identical headlines from different
   * outlets count once. This is not proof that the remaining reports are independent of each other.
   */
  originCount: number;
  firstSeen: string;
  lastSeen: string;
  score: number;
}

export interface SourceHealth {
  sourceId: string;
  ok: boolean;
  /** not-due: not requested this run because its polling interval has not passed. */
  status: 'fresh' | 'stale' | 'failed' | 'not-modified' | 'skipped' | 'not-due';
  items: number;
  lastAttempt: string;
  lastSuccess?: string;
  error?: string;
}

export interface Snapshot {
  schema: 1;
  /** 'prototype' snapshots are captured once for design review and are never presented as live. */
  mode: 'prototype' | 'live';
  generatedAt: string;
  nextUpdateAt: string | null;
  sources: PublicSource[];
  articles: Article[];
  clusters: Cluster[];
  leadClusterId: string | null;
  /** Ordered cluster ids per section and subsection (each cluster shown once on the page). */
  layout: Record<SectionId, Partial<Record<Subsection, string[]>>>;
  perspectives: string[];
  trending: string[];
  breaking: string | null;
  stats: {
    sourcesAttempted: number;
    sourcesOk: number;
    articlesCollected: number;
    duplicatesRemoved: number;
    clustersFormed: number;
    multiSourceClusters: number;
    durationMs: number;
    bytesFetched: number;
  };
}
