import { useState } from 'react';
import type { SectionId } from '../../shared/types.ts';
import { AFFILIATION_LABEL, TYPE_LABEL, countryName } from '../../shared/countries.ts';
import { HALF_LIFE_HOURS } from '../../shared/layout.ts';
import type { SiteData } from '../lib/data.ts';
import { IDENTITY } from '../../shared/identity.ts';
import { SECTION_TITLES } from '../../shared/labels.ts';
import { FEED_LIMITS } from '../../shared/feeds.ts';

export const REPOSITORY = 'https://github.com/RadMageIRL/TheSignal';

const SECTIONS: SectionId[] = ['us', 'world', 'markets', 'outside', 'airwaves', 'pulse'];

export function SourcesPage({ data }: { data: SiteData }) {
  const [sort, setSort] = useState<'section' | 'country'>('section');
  const list = [...data.sources.values()].sort((a, b) => sort === 'country'
    ? countryName(a.country).localeCompare(countryName(b.country)) || a.name.localeCompare(b.name)
    : SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const a of data.articles.values()) counts.set(a.sourceId, (counts.get(a.sourceId) ?? 0) + 1);
  const countries = new Set(list.map((s) => s.country));
  return (
    <main className="page" id="main">
      <h1 className="page-title">Source Directory</h1>
      <p className="page-lede">
        {list.length} sources from {countries.size} countries and international outlets. Ownership is listed so you can weigh each
        headline yourself. Listing a source is not an endorsement of it. A source appears in The Signal's RSS feeds only when
        its terms allow redistribution.
      </p>
      <div className="sort">
        <span>Sort by</span>
        <button type="button" className={sort === 'section' ? 'on' : ''} onClick={() => setSort('section')}>Section</button>
        <button type="button" className={sort === 'country' ? 'on' : ''} onClick={() => setSort('country')}>Country</button>
      </div>
      <div className="table-wrap">
        <table className="directory">
          <thead>
            <tr><th scope="col">Source</th><th scope="col">Country</th><th scope="col">Section</th><th scope="col">Type</th><th scope="col">Ownership</th><th scope="col">In RSS feeds</th><th scope="col">Headlines now</th></tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td><a href={s.homepage} rel="noopener noreferrer" target="_blank">{s.name}</a></td>
                <td>{countryName(s.country)}</td>
                <td>{SECTION_TITLES[s.section]}</td>
                <td>{TYPE_LABEL[s.contentType]}</td>
                <td>{AFFILIATION_LABEL[s.affiliation]}{s.ownership ? `: ${s.ownership}` : ''}</td>
                <td>{s.syndicate ? 'Yes' : 'Not yet'}</td>
                <td className="num">{counts.get(s.id) ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.some((s) => s.notice) && (
        <section className="notices" aria-labelledby="notices-h">
          <h2 id="notices-h" className="band-title">Licences and required notices</h2>
          <p className="page-lede">Some publishers license their headlines on condition that a statement accompanies them. Those statements are reproduced here and in The Signal's RSS feeds.</p>
          <dl className="notice-list">
            {list.filter((s) => s.notice).map((s) => (
              <div key={s.id}><dt>{s.name}</dt><dd>{s.notice}</dd></div>
            ))}
          </dl>
        </section>
      )}
    </main>
  );
}

export function AboutPage() {
  return (
    <main className="page prose" id="main">
      <h1 className="page-title">About and Methodology</h1>
      <p className="page-lede">
        The Signal collects headlines from publishers around the world and links straight to them. The rules that collect,
        group and order those headlines are written out below.
      </p>
      <p className="statement">
        The Signal is built in the spirit of the open internet. We believe information should be discoverable, perspectives
        should be accessible, and readers should be free to draw their own conclusions. Our purpose is to connect people with
        information, not to control their attention.
      </p>

      <h2>What appears here</h2>
      <p>
        Only headlines, the publisher's name, the publication time and a link to the original article. No article text is copied,
        and there are no images, accounts, advertising or tracking. Every headline keeps its original wording.
      </p>

      <h2>How headlines are collected</h2>
      <p>
        A scheduled job reads each publisher's official feed on a fixed interval (every 15 minutes for major news, up to every
        hour for podcasts and science). Visiting the site never triggers a fetch from a publisher. If a feed fails, the rest of the
        page carries on, and if collection stops entirely the site keeps showing the last good update with its time clearly stated.
      </p>

      <h2>How stories are grouped</h2>
      <p>
        Headlines from different outlets are grouped into one story only when they share at least two distinctive words, read
        similarly overall, and were published within about a day and a half of each other. The grouping is automatic and
        deliberately cautious: it would rather show the same event twice than wrongly merge two different events. Dates and
        common words never count as distinctive.
      </p>

      <h2>How the page is ordered</h2>
      <p>The default page is the same for everyone. Each story's score combines:</p>
      <ul>
        <li><strong>Recency.</strong> A story's weight halves every {HALF_LIFE_HOURS} hours after its newest report.</li>
        <li><strong>Coverage.</strong> More outlets carrying a story raises it, with shared copy discounted: items that credit the same wire service count once, the same headline syndicated word for word counts once, and several articles from one outlet, or from editions of one publisher that republish each other, count once.</li>
        <li><strong>Geographic reach.</strong> Coverage from more countries raises a story.</li>
        <li><strong>Type.</strong> Opinion and commentary can appear in news columns but rank below straight reporting. Sports results, personal advice columns, programming notes and roundups rank at about a third of a news story's weight, and reviews at 60 percent; nothing is hidden.</li>
      </ul>
      <p>
        No list shows more than two stories led by the same outlet (or the same family of editions), and the world column shows no
        more than three stories led by outlets from the same country in any region. The lead story is the highest-scoring story
        carried in the last 12 hours by outlets in at least two countries, with at least three reports left after shared copy is
        counted once. There are no political bias scores and no personalization of the default page.
      </p>
      <p>
        A world story is filed under the region its headlines name, not the region of the outlet that published it. A story that
        names only U.S. places or institutions goes to U.S. &amp; Politics, and a story from U.S. outlets that names only a
        foreign place goes to World.
      </p>

      <h2>Counting outlets</h2>
      <p>
        A story shows how many outlets and countries carry it, for example "8 outlets covering this story". That is a count of
        publishers, not a claim that each one reported independently. Feeds rarely say where their copy came from, so the page
        marks shared copy only where the metadata shows it: an item that credits a wire service another outlet in the story also
        carries, or a headline identical to an earlier one from a different outlet.
      </p>

      <h2>Global Perspectives</h2>
      <p>
        When outlets in at least three countries cover the same story, you can compare their headlines side by side, with each
        outlet's ownership and whether the item is reporting or commentary. Putting headlines next to each other does not mean
        they are equally reliable, and the page does not declare a consensus.
      </p>

      <h2>The People's Pulse</h2>
      <p>
        Items here come from public communities. Points, shares and view counts describe activity on that platform only. They are
        not verification, and they are not a measure of public opinion.
      </p>

      <h2>Sources and labels</h2>
      <p>
        Mainstream, public, state-affiliated, independent and alternative outlets are held to the same rules. State-affiliated
        outlets are labeled as such. A source is enabled only after I have confirmed that its feed works and that its terms allow
        this use. Inclusion is not endorsement.
      </p>

      <h2>RSS feeds</h2>
      <p>
        Every section, the most covered stories and Global Perspectives have their own RSS feed, listed on
        the <a href="#/feeds">RSS feeds</a> page. Feeds carry the same headlines and links as the page, but only from publishers
        whose terms allow redistribution, at most {FEED_LIMITS.maxItems} items each, rebuilt with each successful collection run.
      </p>

      <h2>Open source</h2>
      <p>
        The Signal's code is open source under the GNU Affero General Public License, version 3 only, at{' '}
        <a href={REPOSITORY} rel="noopener noreferrer">{REPOSITORY.replace('https://', '')}</a>. The headlines, names and linked
        content shown here belong to their publishers and are not covered by that license. The Signal and RadMage Labs names and
        logos are not licensed for reuse. The open source software The Signal is built on is listed, with its licenses, in
        the <a href="THIRD-PARTY-NOTICES.txt">third-party notices</a>.
      </p>

      <h2>Contact, corrections and publisher requests</h2>
      <p>
        Write to <a href={`mailto:${IDENTITY.contact}`}>{IDENTITY.contact}</a> to report an error, to ask how a story was
        grouped or ranked, or, if you are a publisher, to change how your headlines appear or to have your feed removed. The
        collector identifies itself to publishers with this address in its User-Agent.
      </p>

      <h2>Limits</h2>
      <ul>
        <li>Grouping works on English headlines only and will miss stories worded very differently.</li>
        <li>Some publishers do not give publication times; those headlines show no time.</li>
        <li>Feeds are only as current as their publishers make them.</li>
      </ul>
    </main>
  );
}
