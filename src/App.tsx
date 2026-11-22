import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SectionId } from '../shared/types.ts';
import { buildView, loadSnapshot, type SiteData } from './lib/data.ts';
import { loadPrefs, resolvedTheme, savePrefs, type Prefs } from './lib/prefs.ts';
import { Masthead, Nav, TopBar } from './components/Header.tsx';
import { Breaking, Lead, NewsColumn, PerspectivesBand, Trending } from './components/Sections.tsx';
import { PreferencesPanel, SearchResults } from './components/Panels.tsx';
import { AboutPage, REPOSITORY, SourcesPage } from './components/Pages.tsx';
import { FeedsPage } from './components/Feeds.tsx';
import { DEFAULT_FILTERS, type SearchFilters } from './lib/search.ts';
import type { Ctx } from './components/Story.tsx';
import { IDENTITY } from '../shared/identity.ts';

/** The hash route split into a path and its query, e.g. "#/feeds?feed=us". */
export function splitRoute(route: string): { path: string; params: URLSearchParams } {
  const q = route.indexOf('?');
  return q < 0 ? { path: route, params: new URLSearchParams() } : { path: route.slice(0, q), params: new URLSearchParams(route.slice(q + 1)) };
}

function useRoute(): string {
  const read = () => (window.location.hash.startsWith('#/') ? window.location.hash.slice(1) : '/');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      if (window.location.hash.startsWith('#/')) window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function App() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [data, setData] = useState<SiteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQueryRaw] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const setQuery = useCallback((q: string) => {
    setQueryRaw(q);
    if (q.trim().length <= 1) setFilters(DEFAULT_FILTERS);
  }, []);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const { path: route, params } = splitRoute(useRoute());
  const theme = resolvedTheme(prefs.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = prefs.density;
  }, [theme, prefs.density]);

  useEffect(() => {
    const ctl = new AbortController();
    loadSnapshot(ctl.signal).then(setData).catch((e: unknown) => {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : 'unavailable');
    });
    return () => ctl.abort();
  }, []);

  const update = useCallback((p: Prefs) => { setPrefs(p); savePrefs(p); }, []);
  const disabledKey = prefs.disabledSources.slice().sort().join(',');
  const view = useMemo(() => (data ? buildView(data, new Set(prefs.disabledSources)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, disabledKey]);
  const hidden = new Set<string>(prefs.hiddenSections);
  const ctx: Ctx | null = data && view ? { view, sources: data.sources, nowMs: Date.parse(data.wire.generatedAt) } : null;
  const show = (s: SectionId) => !hidden.has(s);

  return (
    <>
      <a className="skip" href="#main">Skip to headlines</a>
      <div className="wrap">
        <TopBar wire={data?.wire ?? null} query={query} onQuery={setQuery} theme={theme}
          onToggleTheme={() => update({ ...prefs, theme: theme === 'dark' ? 'light' : 'dark' })}
          onPrefs={() => setPrefsOpen(true)} />
        <Masthead />
        <Nav hidden={hidden} />
        {error && !data && (
          <main className="page" id="main">
            <p className="notice">Headlines could not be loaded right now ({error}). Please try again in a few minutes.</p>
          </main>
        )}
        {!data && !error && <main className="page" id="main"><p className="notice">Loading headlines</p></main>}
        {data && ctx && route === '/sources' && <SourcesPage data={data} />}
        {data && ctx && route === '/about' && <AboutPage />}
        {data && ctx && route === '/feeds' && <FeedsPage data={data} focus={params.get('feed') ?? undefined} />}
        {data && ctx && route === '/' && query.trim().length > 1 && (
          <main id="main"><SearchResults query={query} ctx={ctx} filters={filters} onFilters={setFilters} onClear={() => setQuery('')} /></main>
        )}
        {data && ctx && route === '/' && query.trim().length <= 1 && (
          <main id="main">
            <Breaking ctx={ctx} />
            {ctx.view.leadClusterId && <Lead id={ctx.view.leadClusterId} ctx={ctx} />}
            <div className="grid3 primary">
              {show('us') && <NewsColumn section="us" ctx={ctx} />}
              {show('world') && <NewsColumn section="world" ctx={ctx} />}
              {show('markets') && <NewsColumn section="markets" ctx={ctx} />}
            </div>
            <PerspectivesBand ctx={ctx} />
            <div className="grid3 secondary">
              {show('outside') && <NewsColumn section="outside" ctx={ctx} />}
              {show('airwaves') && <NewsColumn section="airwaves" ctx={ctx} />}
              {show('pulse') && <NewsColumn section="pulse" ctx={ctx} />}
            </div>
            <Trending ctx={ctx} />
          </main>
        )}
        <footer className="footer">
          <div className="footer-cols">
            <p>Headlines link to their publishers. The Signal hosts no articles, audio or video, and inclusion of a source is not an endorsement.</p>
            <ul className="footer-links">
              <li><a href="#/about">Methodology</a></li>
              <li><a href="#/sources">Source directory</a></li>
              <li><a href="#/feeds">RSS feeds</a></li>
              <li><a href={`mailto:${IDENTITY.contact}`}>Contact and corrections</a></li>
              <li><button type="button" className="text-btn" onClick={() => setPrefsOpen(true)}>Preferences</button></li>
              <li><a href={REPOSITORY} rel="noopener noreferrer">Source code</a></li>
              <li><a href="https://radmagelabs.com/">RadMage Labs</a></li>
            </ul>
          </div>
          {data && <p className="footer-small">Snapshot {data.wire.generatedAt.replace('T', ' ').slice(0, 16)} UTC. {data.wire.stats.sourcesOk} of {data.wire.stats.sourcesAttempted} sources answered.</p>}
        </footer>
      </div>
      {prefsOpen && <PreferencesPanel prefs={prefs} data={data} onChange={update} onClose={() => setPrefsOpen(false)} />}
    </>
  );
}
