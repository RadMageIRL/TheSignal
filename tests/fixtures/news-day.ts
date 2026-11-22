// A synthetic news day: invented publishers on reserved .example domains, invented places and
// invented headlines. It exercises all six sections, a multi-country lead story with shared wire
// copy and a word-for-word syndicated headline, Global Perspectives, trending, podcasts and
// community items, and sources with and without permission to appear in RSS feeds.
// Nothing here is real news; it is safe to publish with the code.
import type { Article, ContentType, Affiliation, SectionId, SourceEntry, Subsection, Permission } from '../../shared/types.ts';
import { SECTION_OF_SUB } from '../../shared/layout.ts';

export const FIXTURE_NOW = new Date('2026-11-22T12:00:00Z');

type Src = [id: string, name: string, country: string, section: SectionId, type: ContentType, aff: Affiliation, syndication: Permission];

const SOURCES: Src[] = [
  ['capitol-ledger', 'The Capitol Ledger', 'US', 'us', 'reporting', 'private', 'yes'],
  ['federal-bulletin', 'Federal Bulletin', 'US', 'us', 'official', 'government', 'yes'],
  ['prairie-courier', 'Prairie Courier', 'US', 'us', 'reporting', 'private', 'unknown'],
  ['thames-herald', 'Thames Herald', 'GB', 'world', 'reporting', 'private', 'yes'],
  ['ganges-daily', 'Ganges Daily', 'IN', 'world', 'reporting', 'private', 'unknown'],
  ['gulf-monitor', 'Gulf Monitor', 'QA', 'world', 'reporting', 'state', 'yes'],
  ['maple-times', 'Maple Times', 'CA', 'world', 'reporting', 'public-broadcaster', 'yes'],
  ['sakura-shimbun', 'Sakura Shimbun', 'JP', 'world', 'reporting', 'private', 'unknown'],
  ['rio-gazette', 'Rio Gazette', 'BR', 'world', 'reporting', 'government', 'yes'],
  ['lagos-mail', 'Lagos Mail', 'NG', 'world', 'reporting', 'private', 'yes'],
  ['rhine-post', 'Rhine Post', 'DE', 'world', 'reporting', 'public-broadcaster', 'no'],
  ['kiwi-dispatch', 'Kiwi Dispatch', 'NZ', 'world', 'reporting', 'public-broadcaster', 'yes'],
  ['ledger-markets', 'Ledger Markets', 'US', 'markets', 'reporting', 'private', 'yes'],
  ['monetary-office', 'Eurozone Monetary Office', 'EU', 'markets', 'official', 'government', 'yes'],
  ['circuit-review', 'Circuit Review', 'US', 'markets', 'reporting', 'private', 'yes'],
  ['lab-notes', 'Lab Notes Weekly', 'GB', 'markets', 'reporting', 'nonprofit', 'unknown'],
  ['open-record', 'The Open Record', 'US', 'outside', 'investigation', 'independent', 'yes'],
  ['dissent-quarterly', 'Dissent Quarterly', 'GB', 'outside', 'commentary', 'independent', 'yes'],
  ['long-table', 'The Long Table', 'US', 'airwaves', 'podcast', 'independent', 'yes'],
  ['morning-brief', 'Morning Brief', 'GB', 'airwaves', 'podcast', 'private', 'unknown'],
  ['town-square', 'Town Square Forum', 'INT', 'pulse', 'community', 'community', 'yes'],
  ['most-read', 'Encyclopedia Most Read', 'INT', 'pulse', 'community', 'nonprofit', 'yes'],
  // Headlines in other languages: shown as published, labeled, never grouped or translated.
  ['gaceta-corvane', 'Gaceta de Corvane', 'AR', 'world', 'reporting', 'private', 'yes'],
  ['correo-briskvale', 'Correo de Briskvale', 'ES', 'world', 'reporting', 'public-broadcaster', 'yes'],
  ['barid-dunmere', 'Barid Dunmere (بريد دنمير)', 'JO', 'world', 'reporting', 'independent', 'unknown'],
];

/** Sources whose headlines are not in English (BCP 47); every other fixture source is 'en'. */
const LANGUAGE = new Map<string, string>([['gaceta-corvane', 'es'], ['correo-briskvale', 'es-ES'], ['barid-dunmere', 'ar']]);

const FIRST_SUB: Record<SectionId, Subsection> = {
  us: 'national', world: 'world-general', markets: 'global-markets', outside: 'independent', airwaves: 'podcasts', pulse: 'discussions',
};

export function fixtureSources(): SourceEntry[] {
  return SOURCES.map(([id, name, country, section, contentType, affiliation, syndication]) => ({
    id, name, homepage: `https://${id}.example/`, country, region: 'Fixture', language: LANGUAGE.get(id) ?? 'en', section, contentType, affiliation,
    ownership: 'Fictional publisher', intervalMinutes: 15,
    feeds: [{ url: `https://${id}.example/feed.xml`, kind: section === 'airwaves' ? 'podcast' : 'rss', subsection: FIRST_SUB[section] }],
    status: 'READY', statusNote: 'Synthetic test source.', gates: [], termsUrl: `https://${id}.example/terms`,
    attribution: 'name the publisher and link to the article',
    rights: { display: 'yes', syndication, excerpt: 'unknown', images: 'unknown' },
    restrictions: '', enabled: true, reviewed: '2026-11-22',
  }));
}

const country = new Map(SOURCES.map((s) => [s[0], s[2]]));
const typeOf = new Map(SOURCES.map((s) => [s[0], s[4]]));
let seq = 0;

function at(hoursAgo: number): string {
  return new Date(FIXTURE_NOW.getTime() - hoursAgo * 3600_000).toISOString();
}

function art(sourceId: string, sub: Subsection, hoursAgo: number, title: string, extra: Partial<Article> = {}): Article {
  seq++;
  const id = `fx${String(seq).padStart(4, '0')}`;
  return {
    id, sourceId, title, url: `https://${sourceId}.example/news/${id}`, publishedAt: at(hoursAgo), firstSeenAt: FIXTURE_NOW.toISOString(),
    section: SECTION_OF_SUB[sub], subsection: sub, contentType: typeOf.get(sourceId) ?? 'reporting', country: country.get(sourceId) ?? 'US',
    language: LANGUAGE.get(sourceId) ?? 'en', ...extra,
  };
}

const PLACES = ['Aldmoor', 'Briskvale', 'Corvane', 'Dunmere', 'Eskhollow', 'Fennick', 'Glimmerford', 'Harrowgate', 'Ilverton', 'Jessamy',
  'Kestrel', 'Larkspur', 'Morrowind', 'Nettlefield', 'Oakhurst', 'Pellworth', 'Quillon', 'Rothmere', 'Saltmarsh', 'Thistleby'];
const THINGS = ['library budget', 'water main', 'tram line', 'school board', 'harbor dredging', 'bridge toll', 'park renovation',
  'hospital wing', 'festival permit', 'bus depot'];
const VERBS = ['approves', 'delays', 'reviews', 'expands', 'rejects'];

/** Unrelated single-outlet headlines, so word rarity behaves as it does on a real day. */
function filler(): Article[] {
  const out: Article[] = [];
  const pool: [string, Subsection][] = [
    ['prairie-courier', 'national'], ['capitol-ledger', 'national'], ['thames-herald', 'europe'], ['rhine-post', 'europe'],
    ['ganges-daily', 'asia'], ['sakura-shimbun', 'asia'], ['lagos-mail', 'africa-americas'], ['rio-gazette', 'africa-americas'],
    ['gulf-monitor', 'mideast'], ['kiwi-dispatch', 'asia'], ['ledger-markets', 'global-markets'], ['circuit-review', 'tech'],
  ];
  for (let i = 0; i < 96; i++) {
    const [src, sub] = pool[i % pool.length]!;
    const place = PLACES[i % PLACES.length]!;
    const thing = THINGS[Math.floor(i / PLACES.length) % THINGS.length]!;
    const verb = VERBS[i % VERBS.length]!;
    out.push(art(src, sub, 2 + (i % 30), `${place} council ${verb} ${thing} plan, item ${i + 100}`));
  }
  return out;
}

export function fixtureArticles(): Article[] {
  seq = 0;
  const wire = 'Example Wire';
  return [
    // Lead story: seven outlets, seven countries; two carry the same wire copy word for word.
    art('thames-herald', 'world-general', 3.0, 'Ferry capsizes on Lake Varnu, 31 dead'),
    art('ganges-daily', 'asia', 2.8, 'At least 31 dead as ferry capsizes on Lake Varnu'),
    art('gulf-monitor', 'mideast', 2.6, 'Lake Varnu ferry disaster: 31 killed after vessel capsizes', { wire }),
    art('maple-times', 'world-general', 2.4, 'Lake Varnu ferry disaster: 31 killed after vessel capsizes', { wire }),
    art('kiwi-dispatch', 'asia', 2.2, 'Varnu ferry capsizes, killing 31'),
    art('capitol-ledger', 'national', 2.0, 'Ferry capsizes on Lake Varnu; 31 dead, dozens missing'),
    art('sakura-shimbun', 'asia', 1.8, 'Rescuers search Lake Varnu after ferry capsizes, 31 dead'),
    // Global Perspectives: five countries.
    art('rhine-post', 'europe', 6.0, 'Orbis summit agrees landmark ocean treaty'),
    art('rio-gazette', 'africa-americas', 5.6, 'Ocean treaty agreed at Orbis summit after all-night talks'),
    art('lagos-mail', 'africa-americas', 5.2, 'Orbis summit: nations agree ocean treaty'),
    art('thames-herald', 'europe', 5.0, 'Landmark ocean treaty agreed at Orbis summit'),
    art('ganges-daily', 'asia', 4.6, 'Orbis summit ocean treaty deal reached'),
    // Global Perspectives: three countries.
    art('kiwi-dispatch', 'asia', 4.0, 'Calder Bay port strike halts shipping'),
    art('sakura-shimbun', 'asia', 3.6, 'Shipping halted as Calder Bay port strike spreads'),
    art('gulf-monitor', 'mideast', 3.4, 'Calder Bay port strike enters third day, shipping halted'),
    // U.S. & Politics.
    art('capitol-ledger', 'washington', 1.5, 'Senate passes Harlow infrastructure bill after late vote'),
    art('prairie-courier', 'washington', 1.2, 'Harlow infrastructure bill clears Senate in late vote'),
    art('federal-bulletin', 'law', 5.0, 'Agency publishes final rule on grain storage safety'),
    art('prairie-courier', 'national', 7.0, 'Blizzard closes highways across three plains states'),
    art('capitol-ledger', 'economy', 8.0, 'Retail sales rise for fourth straight month'),
    // Markets & Technology.
    art('ledger-markets', 'global-markets', 0.8, 'Stocks edge higher as bond yields fall'),
    art('monetary-office', 'global-markets', 9.0, 'Monetary office holds key rate at 2.25 percent'),
    art('circuit-review', 'tech', 3.2, 'Chipmaker unveils low-power processor for laptops'),
    art('lab-notes', 'science', 10.0, 'Telescope spots water vapor on distant exoplanet'),
    art('ledger-markets', 'crypto', 4.4, 'Token exchange halts withdrawals after outage'),
    // Outside the Mainstream.
    art('open-record', 'investigations', 20.0, 'Records show county paid twice for unused software'),
    art('dissent-quarterly', 'commentary', 30.0, 'The case against another round of stimulus'),
    // The Airwaves.
    art('long-table', 'podcasts', 26.0, 'Episode 212: A historian on the age of empires', { podcast: { show: 'The Long Table', durationSec: 7400, guest: 'Dr. Ada Quill' } }),
    art('morning-brief', 'podcasts', 6.5, 'Tuesday briefing: summit, strike and storm', { podcast: { show: 'Morning Brief', durationSec: 1500 } }),
    // The People's Pulse.
    art('town-square', 'discussions', 2.5, 'Ask the forum: how do you back up family photos?', {
      community: { platform: 'Town Square Forum', origin: 'town-square.example', points: 412, comments: 133, discussionUrl: 'https://town-square.example/t/4412' },
    }),
    art('most-read', 'reading', 12.0, 'Lake Varnu', { community: { platform: 'Encyclopedia Most Read', origin: 'most-read.example', points: 120000 } }),
    ...filler(),
    // The lead story as outlets in other languages headlined it. The two Spanish headlines say the
    // same thing in nearly the same words; they still stay apart (grouping reads English only).
    art('gaceta-corvane', 'africa-americas', 2.5, 'Naufraga un ferri en el lago Varnu: al menos 31 muertos'),
    art('correo-briskvale', 'europe', 2.3, 'Al menos 31 muertos al naufragar un ferri en el lago Varnu'),
    art('barid-dunmere', 'mideast', 2.1, 'غرق عبّارة في بحيرة فارنو ومقتل 31 شخصاً'),
  ];
}

/** The fixture news day assembled exactly as a collection run would assemble it. */
export async function fixtureSnapshot(): Promise<import('../../shared/types.ts').Snapshot> {
  const { assembleSnapshot } = await import('../../ingest/run.ts');
  const sources = fixtureSources();
  return assembleSnapshot(sources, fixtureArticles(), { now: FIXTURE_NOW, mode: 'live', nextUpdateAt: null },
    { sourcesOk: sources.length, durationMs: 0, bytesFetched: 0 });
}
