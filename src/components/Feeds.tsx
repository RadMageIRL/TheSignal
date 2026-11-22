import { useEffect, useMemo, useRef, useState } from 'react';
import { FEED_LIMITS, FEED_SPECS, feedUrl, type FeedSpec } from '../../shared/feeds.ts';
import type { SiteData } from '../lib/data.ts';
import { RssIcon } from './Rss.tsx';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('select'); // clipboard unavailable: the address is selectable text next to the button
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };
  return (
    <button type="button" className="copy-btn" onClick={copy} aria-label={`Copy the address of ${label}`}>
      {state === 'copied' ? 'Copied' : state === 'select' ? 'Select and copy' : 'Copy'}
    </button>
  );
}

function scopeCount(spec: FeedSpec, data: SiteData, ok: Set<string>): { eligible: number; total: number } {
  if (spec.scope === 'trending' || spec.scope === 'perspectives') {
    const ids = spec.scope === 'trending' ? data.wire.trending : data.wire.perspectives;
    const byId = new Map(data.wire.clusters.map((c) => [c.i, c]));
    const eligible = ids.filter((id) => (byId.get(id)?.a ?? []).some((a) => ok.has(data.articles.get(a)?.sourceId ?? ''))).length;
    return { eligible, total: ids.length };
  }
  const scope = [...data.articles.values()].filter((a) => spec.scope === 'all' || a.section === spec.section);
  return { eligible: scope.filter((a) => ok.has(a.sourceId)).length, total: scope.length };
}

export function FeedsPage({ data, focus }: { data: SiteData; focus?: string }) {
  const sources = [...data.sources.values()];
  const ok = useMemo(() => new Set(sources.filter((s) => s.syndicate).map((s) => s.id)), [sources]);
  const included = sources.filter((s) => ok.has(s.id)).sort((a, b) => a.name.localeCompare(b.name));
  const prototype = data.wire.mode === 'prototype';
  useEffect(() => {
    if (focus) document.getElementById(`feed-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus]);
  return (
    <main className="page prose feeds-page" id="main">
      <h1 className="page-title"><span className="title-icon"><RssIcon size={22} /></span> RSS Feeds</h1>
      <p className="page-lede">
        Follow The Signal in any feed reader, without visiting the site. Each feed lists headlines with links straight to their
        publishers, rebuilt with every collection run.
      </p>
      {prototype && (
        <p className="notice-inline">
          Preview: these feeds are not published yet. The addresses below are where they will be served once the site goes live.
        </p>
      )}

      <ul className="feed-list">
        {FEED_SPECS.map((spec) => {
          const url = feedUrl(spec);
          const n = scopeCount(spec, data, ok);
          return (
            <li key={spec.id} id={`feed-${spec.id}`} className={focus === spec.id ? 'feed focus' : 'feed'}>
              <div className="feed-head">
                <h2 className="feed-title">{spec.title}</h2>
                <span className="feed-count">
                  {spec.scope === 'trending' || spec.scope === 'perspectives'
                    ? `${n.eligible} of ${n.total} stories in the current snapshot`
                    : `${n.eligible} of ${n.total} headlines in the current snapshot`}
                </span>
              </div>
              <p className="feed-desc">{spec.description}</p>
              <div className="feed-url">
                <code>{url}</code>
                <CopyButton text={url} label={`the ${spec.title} feed`} />
              </div>
            </li>
          );
        })}
      </ul>

      <h2>How to subscribe</h2>
      <ol>
        <li>Copy the address of a feed above.</li>
        <li>Open your feed reader (an app or a web service) and choose its option to add or subscribe to a feed.</li>
        <li>Paste the address. New headlines will appear in your reader as The Signal updates.</li>
      </ol>
      <p>Many readers can also find these feeds by themselves: give them the address of the front page.</p>

      <h2>What the feeds contain</h2>
      <p>
        Each item is one headline exactly as its publisher wrote it, a direct link to the original article, the publisher's name,
        the original publication time when the publisher gives one, and the section and country. Items in the Most covered and
        Global Perspectives feeds also say how many outlets and countries carried the story. There is no article text, no excerpt
        and no image.
      </p>

      <h2>Which publishers appear</h2>
      <p>
        Permission to show a headline on this site does not always include permission to redistribute it in another feed, so the
        feeds only carry publishers whose terms allow that. Right now {included.length} of {sources.length} sources in the
        current snapshot qualify.
        {included.length === 0 && ' Feeds will fill in as publishers confirm that their terms allow it.'}
      </p>
      {included.length > 0 && <p className="feed-sources">{included.map((s) => s.name).join(', ')}.</p>}

      <h2>Updates and polling</h2>
      <p>
        Feeds are rebuilt only when a collection run succeeds, which normally happens every 15 minutes. If collection pauses, the
        last good feeds stay available with their true build time. Please poll at most every {FEED_LIMITS.ttlMinutes} minutes;
        each feed says so in its <code>ttl</code> element. Each feed holds at most {FEED_LIMITS.maxItems} items
        ({FEED_LIMITS.maxItemsAll} for All headlines).
      </p>

      <h2>Use</h2>
      <p>
        The feeds are free to read and to follow. Headlines, names and the articles they link to belong to their publishers;
        please link to the original rather than copy it. Listing a source is not an endorsement of it.
      </p>
    </main>
  );
}
