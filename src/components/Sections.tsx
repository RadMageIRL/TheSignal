import { useId, useState } from 'react';
import type { SectionId } from '../../shared/types.ts';
import { countryName } from '../../shared/countries.ts';
import { NEWS_SECTIONS, SECTION_SUBS } from '../../shared/layout.ts';
import { SECTION_TITLES, SUB_TITLES } from '../../shared/labels.ts';
import { FEED_SPECS, feedForSection } from '../../shared/feeds.ts';
import { sharedCopyOutlets } from '../../shared/cluster.ts';
import { absoluteTime, relativeTime } from '../lib/time.ts';
import { clusterArticles } from '../lib/data.ts';
import { EpisodeItem, Meta, PerspectivesTable, PulseItem, StoryItem, TypeBadge, type Ctx } from './Story.tsx';
import { RssLink } from './Rss.tsx';
import { headlineLangAttrs } from '../../shared/languages.ts';

export { SECTION_TITLES, SUB_TITLES };

const NOTES: Partial<Record<SectionId, string>> = {
  outside: 'Independent and alternative outlets from across the spectrum. Inclusion is not endorsement; commentary is labeled as commentary.',
  airwaves: 'Latest episodes from official podcast feeds. Every link opens the show itself; nothing is hosted here.',
  pulse: 'What public communities are sharing and discussing. Activity counts are platform activity, not verification and not a measure of public opinion.',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const feedSpec = (id: string) => FEED_SPECS.find((f) => f.id === id)!;

export function Lead({ id, ctx }: { id: string; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const c = ctx.view.clusters.get(id);
  const lead = c ? ctx.view.articles.get(c.leadArticleId) : undefined;
  if (!c || !lead) return null;
  const s = ctx.sources.get(lead.sourceId);
  const copies = sharedCopyOutlets(clusterArticles(ctx.view, id));
  return (
    <section className="lead" aria-labelledby="lead-h">
      <p className="kicker">
        <span className="kicker-label">Lead story</span>
        <span>{plural(c.sourceCount, 'outlet', 'outlets')} covering this story</span>
        <span>{plural(c.countryCount, 'country', 'countries')}</span>
        {copies > 0 && <span>{copies} with shared wire or identical copy</span>}
      </p>
      <h2 id="lead-h" className="lead-headline">
        <a href={lead.url} rel="noopener noreferrer" target="_blank" {...headlineLangAttrs(lead.language)}>{lead.title}</a>
      </h2>
      <p className="lead-meta">
        <TypeBadge type={lead.contentType} />
        <span className="pub">{s?.name}</span>
        <span>{countryName(lead.country)}</span>
        {lead.publishedAt && <time dateTime={lead.publishedAt}>{absoluteTime(lead.publishedAt)} ({relativeTime(lead.publishedAt, ctx.nowMs)})</time>}
      </p>
      {c.articleIds.length > 1 && (
        <>
          <button type="button" className="persp-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Compare'} how {c.sourceCount} outlets in {plural(c.countryCount, 'country', 'countries')} headlined it
          </button>
          {open && <div id={panelId} className="persp-panel"><PerspectivesTable clusterId={id} ctx={ctx} /></div>}
        </>
      )}
    </section>
  );
}

export function NewsColumn({ section, ctx }: { section: SectionId; ctx: Ctx }) {
  const lists = ctx.view.layout[section] ?? {};
  const isNews = NEWS_SECTIONS.includes(section);
  const feed = feedForSection(section);
  let first = true;
  return (
    <section className={`column column-${section}`} id={section} aria-labelledby={`${section}-h`}>
      <div className="column-head">
        <h2 className="column-title" id={`${section}-h`}>{SECTION_TITLES[section]}</h2>
        {feed && <RssLink spec={feed} />}
      </div>
      {NOTES[section] && <p className="section-note">{NOTES[section]}</p>}
      {SECTION_SUBS[section].map((sub) => {
        const ids = lists[sub] ?? [];
        if (ids.length === 0) return null;
        return (
          <div className="sub" key={sub}>
            <h3 className="sub-title">{SUB_TITLES[sub]}</h3>
            <ul className="stories">
              {ids.map((id) => {
                // News sections list stories (cluster ids); the others list articles.
                if (!isNews) {
                  const a = ctx.view.articles.get(id);
                  if (!a) return null;
                  if (section === 'airwaves') return <EpisodeItem key={id} a={a} ctx={ctx} />;
                  if (section === 'pulse') return <PulseItem key={id} a={a} ctx={ctx} />;
                  return <StoryItem key={id} articleId={id} ctx={ctx} />;
                }
                const size = first ? 'top' : 'normal';
                first = false;
                return <StoryItem key={id} clusterId={id} ctx={ctx} size={size} />;
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export function PerspectivesBand({ ctx }: { ctx: Ctx }) {
  const ids = ctx.view.perspectives;
  if (ids.length === 0) {
    // Shown rather than hidden, so the menu link lands somewhere and says why it is empty.
    return (
      <section className="band perspectives" id="perspectives" aria-labelledby="persp-h">
        <div className="band-head">
          <h2 id="persp-h" className="band-title">Global Perspectives</h2>
          <p className="band-note persp-empty">
            No story in this snapshot was reported by outlets in three or more countries whose headlines The Signal may show, so
            there is nothing to compare yet. This section fills in as more international publishers are cleared; stories are
            never grouped on weaker evidence to fill it.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="band perspectives" id="perspectives" aria-labelledby="persp-h">
      <div className="band-head">
        <h2 id="persp-h" className="band-title">Global Perspectives <RssLink spec={feedSpec('perspectives')} /></h2>
        <p className="band-note">The same story as newsrooms in different countries headlined it, in their original wording. Grouping is automatic and deliberately cautious.</p>
      </div>
      <div className="persp-grid">
        {ids.map((id) => {
          const c = ctx.view.clusters.get(id)!;
          const arts = clusterArticles(ctx.view, id);
          const byCountry = new Map<string, typeof arts>();
          for (const a of arts) byCountry.set(a.country, [...(byCountry.get(a.country) ?? []), a]);
          return (
            <article className="persp-card" key={id}>
              <p className="kicker"><span>{plural(c.countryCount, 'country', 'countries')}</span><span>{plural(c.sourceCount, 'outlet', 'outlets')}</span></p>
              <ul className="persp-lines">
                {[...byCountry.entries()].slice(0, 6).map(([cc, list]) => (
                  <li key={cc}>
                    <abbr className="cc" title={countryName(cc)}>{cc}</abbr>
                    <a href={list[0]!.url} rel="noopener noreferrer" target="_blank" {...headlineLangAttrs(list[0]!.language)}>{list[0]!.title}</a>
                    <Meta a={list[0]!} ctx={ctx} showCountry={false} />
                  </li>
                ))}
              </ul>
              {byCountry.size > 6 && <p className="more">and {plural(byCountry.size - 6, 'more country', 'more countries')}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function Trending({ ctx }: { ctx: Ctx }) {
  if (ctx.view.trending.length === 0) return null;
  return (
    <section className="band trending" id="trending" aria-labelledby="trend-h">
      <h2 id="trend-h" className="band-title">Most covered, last six hours <RssLink spec={feedSpec('trending')} /></h2>
      <ol className="trend-list">
        {ctx.view.trending.map((id) => {
          const c = ctx.view.clusters.get(id)!;
          const a = ctx.view.articles.get(c.leadArticleId)!;
          return (
            <li key={id}>
              <a href={a.url} rel="noopener noreferrer" target="_blank" {...headlineLangAttrs(a.language)}>{a.title}</a>
              <span className="meta"><span className="pub">{ctx.sources.get(a.sourceId)?.name}</span><span>{plural(c.sourceCount, 'outlet', 'outlets')}</span></span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function Breaking({ ctx }: { ctx: Ctx }) {
  const id = ctx.view.breaking;
  if (!id) return null;
  const c = ctx.view.clusters.get(id);
  const a = c ? ctx.view.articles.get(c.leadArticleId) : undefined;
  if (!c || !a) return null;
  return (
    <div className="breaking" role="region" aria-label="Developing story">
      <span className="breaking-label">Developing</span>
      <a href={a.url} rel="noopener noreferrer" target="_blank" {...headlineLangAttrs(a.language)}>{a.title}</a>
      <span className="meta">{plural(c.sourceCount, 'outlet', 'outlets')} in {plural(c.countryCount, 'country', 'countries')} since {absoluteTime(c.firstSeen)}</span>
    </div>
  );
}
