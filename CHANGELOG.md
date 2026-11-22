# Changelog

All notable changes to The Signal are recorded here. Nothing has been released yet.

## Unreleased

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

### Changed

- Story counts now say how many outlets cover a story and mark identified shared copy, instead of counting
  "independent reports".
- Multinational and EU outlets no longer count as countries.
- World stories are filed by the place their headlines name; sports results, advice columns, programming notes and
  reviews rank lower in news columns.
- The lead story takes slightly less vertical space.
