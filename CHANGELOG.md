# Changelog

All notable changes to The Signal are recorded here.

## 0.1.1 (2026-11-22)

### Added

- Share, in the top bar and the footer: the browser's own share sheet where there is one, otherwise the address
  https://radmagelabs.com/signal/ is copied and the page says so (or shows it to copy by hand). No third-party code.
- Buy me a coffee links in the top bar and the footer, to the RadMage Labs support page.

### Changed

- A headline its publisher labels as opinion or commentary ("Opinion:", "Commentary |", "... - opinion") ranks as
  opinion or commentary even when it arrives in a news feed, and opinion and commentary never become the lead story.
  They still appear in their columns. Only a label at the start or end of a headline counts.
- Items their publisher labels as sponsored or paid content ("Sponsored Commentary:", "Paid Post:", "[Sponsored]") are
  left out of the page and the feeds.
- The methodology page states these rules, and how the lead story is chosen before any story is carried by outlets in
  two countries.
- The production runtime is pinned to Node.js 24, the version the tests run on.

## 0.1.0 (2026-11-22)

First public release, at https://radmagelabs.com/signal/.

### Added

- Source registry (`registry/sources.json`) with 425 researched sources, five statuses, and separate permissions for
  website display, RSS redistribution, excerpts and images, plus required licence notices and editorial networks.
  Registry rules checked by `node tools/registry.ts check`.
- Outgoing RSS 2.0 feeds built from each snapshot: all headlines, the six sections, most covered and Global
  Perspectives. Only publishers that allow redistribution appear; items carry the original headline, link, publication
  time, publisher as `<source>` and categories; output is deterministic and size-capped.
- RSS directory page, RSS links in the utility bar and beside each section, and autodiscovery links.
- Search filters for section, source, country, publication age and sort order.
- Workload controls for the collector: collection off unless `SIGNAL_INGEST=on`, hard ceilings on feeds, bytes, time,
  concurrency and retries, and publish checks that keep the last good snapshot.
- Snapshot schema checks used by the collector before publishing and by the page on load.
- Synthetic fixtures for all six sections and a regression fixture for very large stories that split into several
  groups.
- Browser tests on desktop and mobile with accessibility checks; mutation pass and test-name audit.
- Dependency license audit and third-party notices.
- A robots.txt gate in the collector and the source validator: robots.txt is read and evaluated before any request for
  a publisher's content and before following any redirect. A disallowed feed, or one whose robots.txt cannot be
  reached, is never requested. Answers are reused within a run and kept for at most 24 hours. Regression tests pin the
  order of requests.
- Headlines in other languages: shown as published with a language label, marked up with their language for browsers
  and screen readers, filterable in search, and hideable by language in Preferences. RSS items in other languages carry
  `dc:language` and a language category. Eight researched sources in French, Indonesian, Spanish, Portuguese, Chinese
  and Arabic are enabled for collection.

- Polling schedules: each feed is requested only once its registry interval has passed, with conditional requests,
  backoff after failures, a day's cool-down for a site that answers 419 or 429, and Crawl-delay kept across runs. The
  schedule is saved before each run's first request, a run that starts less than ten minutes after the previous one is
  refused, and a missing or unreadable schedule stops the run before any request.
- First-seen times: items are aged by when The Signal first saw them when the feed gives no publication time, or one in
  the future or later than the first sighting. The snapshot carries the first-seen time for those items.
- Outgoing RSS feeds are checked before publishing: well-formed RSS 2.0, and every item from a source that allows
  redistribution.
- A request audit for local collection runs (`tools/collect-local.ts`) that replays every request against robots.txt,
  Crawl-delay, intervals, cool-downs and the declared identity, and stops at the first violation.
- Production collection on Vercel Cron with Vercel Blob storage: a kill switch that needs no redeploy, a store identity
  check, a recovery drill, private history for rollback, operations logs kept 14 days, and post-deploy checks.
- Launch monitoring (`tools/monitor.ts`) that also counts the RadMage Labs side of the radmagelabs.com/signal/
  rewrite: Labs CDN requests against their pre-launch level, and whether Labs caches the rewritten files.
- Security headers, including a Content-Security-Policy with no inline exceptions beyond the hashed theme script; the
  browser tests run under it.
- A privacy section on the methodology page.
- Link-preview metadata (Open Graph and Twitter card) for radmagelabs.com/signal/, and a robots.txt that keeps the
  project's own Vercel address out of search indexes.

### Changed

- robots.txt is read more strictly than RFC 9309 requires: only a robots file, or a 404 or 410 from the site's own
  host, is an answer. A refused file, a redirect to a missing file on another host, or an HTML page in place of
  robots.txt is treated as disallowing everything. Six sources whose robots.txt cannot be evaluated this way are held.
- The nine The Conversation editions and Tech Policy Press are polled every 120 minutes instead of every 30: their
  full-text feeds offer no conditional requests.
- Global Perspectives says why it is empty instead of disappearing when no story has headlines from three or more
  countries.
- ECB items that bear their authors' names (speeches, interviews, blog posts, press conference transcripts) are left
  out; CDC is marked as not redistributable through RSS, following its syndication guidelines.
- Story counts now say how many outlets cover a story and mark identified shared copy, instead of counting
  "independent reports".
- Multinational and EU outlets no longer count as countries.
- World stories are filed by the place their headlines name; sports results, advice columns, programming notes and
  reviews rank lower in news columns.
- Story grouping reads English headlines only, and headlines in other languages now stay out of it explicitly, so they
  never add to a story's outlet or country count.
- The lead story takes slightly less vertical space.
