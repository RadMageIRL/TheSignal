# The Signal

One world. Many perspectives. Draw your own conclusions.

The Signal is a news front page that collects headlines from newsrooms, public institutions, independent outlets,
podcasts and public communities around the world, groups the ones about the same story, and links every headline
straight to its publisher. It is planned for [radmagelabs.com/signal/](https://radmagelabs.com/signal/) as part of
RadMage Labs.

> The Signal is built in the spirit of the open internet. We believe information should be discoverable, perspectives
> should be accessible, and readers should be free to draw their own conclusions. Our purpose is to connect people with
> information, not to control their attention.

All signal. No noise.

## Status

In development. Nothing is deployed and nothing has been released. The site, its collector and its RSS feeds are not
public yet; the version in `package.json` stays at 0.0.0 until the first release (planned as v0.1.0).

## What it shows

- Only a headline as the publisher wrote it, the publisher's name, the publication time and a direct link. No article
  text, no excerpts, no images, no accounts, no advertising and no tracking.
- Six sections: U.S. & Politics, World News, Markets & Technology, Outside the Mainstream, The Airwaves (podcasts) and
  The People's Pulse (public communities), plus a lead story, Global Perspectives (one story as outlets in at least three
  countries headlined it) and the stories carried by the most outlets in the last six hours.
- Counts are honest about what they count: "8 outlets covering this story" is a count of publishers, and shared copy
  (the same wire story, or a headline repeated word for word) is marked where the metadata shows it.
- Search with section, source, country, date and sort filters; dark and light themes; preferences that stay in the
  reader's browser.
- RSS 2.0 feeds for every section, the most covered stories and Global Perspectives, carrying only publishers whose
  terms allow redistribution.

The methodology page in the app states the exact grouping, ranking and placement rules.

## How it works

- `registry/sources.json` lists every source I have researched, with its feeds, ownership, status, terms and four
  separate permissions: website display, redistribution through The Signal's RSS feeds, excerpts and images. A source
  is collected only when its status is READY (its feed works, its terms affirmatively allow headline-and-link display on
  a public non-commercial site, robots.txt allows the feed and any identity requirement is met), it has no open gates,
  and it is enabled. Other statuses are CONDITIONAL, RESEARCH, DEFERRED and UNAVAILABLE.
- A scheduled collector (`ingest/`) reads each enabled feed with a declared User-Agent
  (`TheSignal/0.1.0 (https://radmagelabs.com/signal/; radmageirl@radmagelabs.com)`), respects robots.txt, and runs inside
  hard limits on feeds, bytes, time, concurrency and retries. Collection is off unless `SIGNAL_INGEST=on`.
- Each run builds one compact snapshot (`shared/`: dedupe, cautious story grouping, transparent ranking and layout) and
  the RSS feeds from the same data. A run that fails its checks never replaces the last good snapshot.
- The page (`src/`, Vite + React + TypeScript) is static and reads the snapshot; visiting it never triggers a request to a
  publisher.

## Development

Requires Node.js 24.

```sh
npm ci
npm run dev                         # http://127.0.0.1:4390/signal/ with the synthetic fixture
npm test                            # unit tests (Vitest)
npm run test:e2e                    # browser tests with accessibility checks (Playwright + axe)
npm run check                       # types, unit tests, registry and fixture checks
node tools/mutate.mjs               # mutation pass: every mutant must make a unit test fail
node tools/lint-tests.mjs           # test names checked against their assertions
node tools/license-audit.mjs        # dependency licenses against AGPL-3.0-only
node tools/notices.mjs --check      # THIRD-PARTY-NOTICES.txt is current
node tools/validate-sources.ts --only <ids>   # check feeds and robots.txt for registry sources
```

The test fixtures in `tests/fixtures/` are synthetic: invented publishers on reserved `.example` domains, invented
places and invented headlines.

## Layout

- `src/` the page
- `shared/` data model, grouping, ranking, layout, RSS output, snapshot schema, registry rules, identity
- `ingest/` fetching (allowlist, SSRF checks, size and time caps), parsing, normalization, robots.txt, workload controls
- `registry/` the source registry
- `tools/` validators, fixture and notice generators, audits
- `tests/` unit and browser tests, synthetic fixtures

## Licensing

- Code: Copyright (c) 2026 RadMageIRL. Licensed under the GNU Affero General Public License, version 3 only
  (AGPL-3.0-only). See [LICENSE](LICENSE).
- Documentation: the original text of `README.md` and `CHANGELOG.md` is licensed under
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Names and branding: The Signal and RadMage Labs names, logos and original brand assets are not licensed under the
  AGPL or CC BY-SA. All rights reserved. Under section 7(e) of the AGPL, no rights are granted under trademark law.
- Third-party content: headlines, publisher names, linked articles, media and publisher assets belong to their owners
  and are not covered by this project's licenses. The repository contains no captured third-party content.
- Third-party software keeps its own licenses, listed verbatim in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

## Contact

Corrections, questions about how a story was grouped or ranked, and publisher requests (including removal):
radmageirl@radmagelabs.com.
