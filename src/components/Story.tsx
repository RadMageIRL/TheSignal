import { useId, useState } from 'react';
import type { Article } from '../../shared/types.ts';
import { AFFILIATION_LABEL, TYPE_LABEL, countryName } from '../../shared/countries.ts';
import { absoluteTime, duration, shortAge } from '../lib/time.ts';
import type { SourceMeta, View } from '../lib/data.ts';
import { clusterArticles } from '../lib/data.ts';
import { copyNotes } from '../../shared/cluster.ts';

export interface Ctx {
  view: View;
  sources: Map<string, SourceMeta>;
  nowMs: number;
}

const BADGE_TYPES = new Set(['opinion', 'commentary', 'official', 'investigation']);

export function TypeBadge({ type }: { type: string }) {
  if (!BADGE_TYPES.has(type)) return null;
  return <span className={`badge badge-${type}`}>{TYPE_LABEL[type]}</span>;
}

export function Meta({ a, ctx, showCountry = true }: { a: Article; ctx: Ctx; showCountry?: boolean }) {
  const s = ctx.sources.get(a.sourceId);
  return (
    <span className="meta">
      <span className="pub">{s?.name ?? a.sourceId}</span>
      {showCountry && <abbr className="cc" title={countryName(a.country)}>{a.country}</abbr>}
      {a.publishedAt && (
        <time dateTime={a.publishedAt} title={absoluteTime(a.publishedAt)}>{shortAge(a.publishedAt, ctx.nowMs)}</time>
      )}
      {a.wire && <span className="wire" title={`The item credits ${a.wire}`}>via {a.wire}</span>}
    </span>
  );
}

/** One headline with its publisher line, and a disclosure listing other outlets' headlines. */
export function StoryItem({ clusterId, articleId, ctx, size = 'normal' }: {
  clusterId?: string; articleId?: string; ctx: Ctx; size?: 'lead' | 'top' | 'normal';
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // Either a story (cluster) led by its lead report, or one specific article with the
  // other outlets that covered the same story.
  const cid = clusterId ?? (articleId ? ctx.view.clusterOf.get(articleId) : undefined);
  const c = cid ? ctx.view.clusters.get(cid) : undefined;
  const lead = ctx.view.articles.get(articleId ?? c?.leadArticleId ?? '');
  if (!lead) return null;
  const others = cid ? clusterArticles(ctx.view, cid).filter((a) => a.id !== lead.id) : [];
  return (
    <li className={`story story-${size}`}>
      <a className="headline" href={lead.url} rel="noopener noreferrer" target="_blank">{lead.title}</a>
      <div className="story-meta">
        <TypeBadge type={lead.contentType} />
        <Meta a={lead} ctx={ctx} />
        {others.length > 0 && (
          <button type="button" className="related" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            +{others.length} {others.length === 1 ? 'outlet' : 'outlets'}
          </button>
        )}
      </div>
      {open && others.length > 0 && (
        <ul className="related-list" id={panelId}>
          {others.map((a) => (
            <li key={a.id}>
              <a href={a.url} rel="noopener noreferrer" target="_blank">{a.title}</a>
              <Meta a={a} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Headlines for one story grouped by country, original wording, with ownership notes. */
export function PerspectivesTable({ clusterId, ctx }: { clusterId: string; ctx: Ctx }) {
  const all = clusterArticles(ctx.view, clusterId);
  const notes = copyNotes(all);
  const arts = all
    .slice()
    .sort((a, b) => countryName(a.country).localeCompare(countryName(b.country)) || Date.parse(a.publishedAt ?? '') - Date.parse(b.publishedAt ?? ''));
  return (
    <table className="persp-table">
      <caption className="sr-only">Headlines from each outlet, grouped by country</caption>
      <thead>
        <tr><th scope="col">Country</th><th scope="col">Outlet</th><th scope="col">Headline as published</th><th scope="col">Published</th></tr>
      </thead>
      <tbody>
        {arts.map((a, i) => {
          const s = ctx.sources.get(a.sourceId);
          const firstOfCountry = i === 0 || arts[i - 1]!.country !== a.country;
          return (
            <tr key={a.id} className={firstOfCountry ? 'country-start' : undefined}>
              <td className="persp-country">{firstOfCountry ? countryName(a.country) : ''}</td>
              <td className="persp-outlet">
                <span className="pub">{s?.name}</span>
                <span className="own">{AFFILIATION_LABEL[s?.affiliation ?? 'unknown']}{s?.ownership ? `: ${s.ownership}` : ''}</span>
              </td>
              <td className="persp-headline">
                <a href={a.url} rel="noopener noreferrer" target="_blank">{a.title}</a>
                <span className="persp-type">
                  {TYPE_LABEL[a.contentType]}{a.wire ? `, credits ${a.wire}` : ''}
                  {notes.get(a.id)?.sameAs && <span className="copy-note">Same headline as {ctx.sources.get(ctx.view.articles.get(notes.get(a.id)!.sameAs!)?.sourceId ?? '')?.name ?? 'another outlet'}</span>}
                </span>
              </td>
              <td className="persp-time">
                {a.publishedAt ? <time dateTime={a.publishedAt}>{absoluteTime(a.publishedAt)}</time> : 'Not given'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function EpisodeItem({ a, ctx }: { a: Article; ctx: Ctx }) {
  return (
    <li className="story episode">
      <span className="show">{a.podcast?.show}</span>
      <a className="headline" href={a.url} rel="noopener noreferrer" target="_blank">{a.title}</a>
      <div className="story-meta">
        <span className="meta">
          {a.podcast?.guest && <span>with {a.podcast.guest}</span>}
          {a.podcast?.durationSec ? <span>{duration(a.podcast.durationSec)}</span> : null}
          {a.publishedAt && <time dateTime={a.publishedAt} title={absoluteTime(a.publishedAt)}>{shortAge(a.publishedAt, ctx.nowMs)}</time>}
        </span>
      </div>
    </li>
  );
}

export function PulseItem({ a, ctx }: { a: Article; ctx: Ctx }) {
  const c = a.community;
  const counts: string[] = [];
  if (c?.points) counts.push(a.sourceId === 'mastodon-social' ? `shared by ${c.points} accounts` : a.sourceId === 'wikipedia-top' ? `${c.points.toLocaleString()} views` : `${c.points} points`);
  if (c?.comments) counts.push(`${c.comments} comments`);
  return (
    <li className="story pulse-item">
      <a className="headline" href={a.url} rel="noopener noreferrer" target="_blank">{a.title}</a>
      <div className="story-meta">
        <span className="meta">
          <span className="pub">{c?.platform}</span>
          {c?.origin && c.origin !== new URL(ctx.sources.get(a.sourceId)?.homepage ?? 'https://x.invalid').hostname && <span>{c.origin}</span>}
          {counts.length > 0 && <span className="activity">{counts.join(', ')}</span>}
          {c?.discussionUrl && <a href={c.discussionUrl} rel="noopener noreferrer" target="_blank">discussion</a>}
          {a.publishedAt && a.sourceId !== 'wikipedia-top' && (
            <time dateTime={a.publishedAt} title={absoluteTime(a.publishedAt)}>{shortAge(a.publishedAt, ctx.nowMs)}</time>
          )}
        </span>
      </div>
    </li>
  );
}
