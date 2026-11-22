import { useEffect, useMemo, useRef, useState } from 'react';
import type { SectionId } from '../../shared/types.ts';
import { DEFAULT_PREFS, type Prefs, type Theme, type Density } from '../lib/prefs.ts';
import type { SiteData } from '../lib/data.ts';
import { SECTION_TITLES } from '../../shared/labels.ts';
import { DEFAULT_FILTERS, RESULT_LIMIT, searchArticles, type SearchFilters, type SortOrder, type Within } from '../lib/search.ts';
import { Meta, type Ctx } from './Story.tsx';

const SECTIONS: SectionId[] = ['us', 'world', 'markets', 'outside', 'airwaves', 'pulse'];

export function PreferencesPanel({ prefs, data, onChange, onClose }: {
  prefs: Prefs; data: SiteData | null; onChange: (p: Prefs) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const disabled = new Set(prefs.disabledSources);
  const hidden = new Set(prefs.hiddenSections);
  const sources = data ? [...data.sources.values()] : [];
  const f = filter.trim().toLowerCase();
  const toggleSource = (id: string) => {
    const next = new Set(disabled);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange({ ...prefs, disabledSources: [...next] });
  };
  return (
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="prefs-h" ref={ref}>
        <div className="drawer-head">
          <h2 id="prefs-h">Preferences</h2>
          <button type="button" className="text-btn" onClick={onClose}>Close</button>
        </div>
        <p className="drawer-note">Saved in this browser only. Nothing is sent anywhere.</p>
        <fieldset>
          <legend>Theme</legend>
          {(['dark', 'light', 'system'] as Theme[]).map((t) => (
            <label key={t} className="choice"><input type="radio" name="theme" checked={prefs.theme === t} onChange={() => onChange({ ...prefs, theme: t })} />{t[0]!.toUpperCase() + t.slice(1)}</label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Density</legend>
          {(['compact', 'comfortable'] as Density[]).map((d) => (
            <label key={d} className="choice"><input type="radio" name="density" checked={prefs.density === d} onChange={() => onChange({ ...prefs, density: d })} />{d[0]!.toUpperCase() + d.slice(1)}</label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Sections</legend>
          {SECTIONS.map((s) => (
            <label key={s} className="choice">
              <input type="checkbox" checked={!hidden.has(s)} onChange={() => {
                const next = new Set(hidden);
                if (next.has(s)) next.delete(s); else next.add(s);
                onChange({ ...prefs, hiddenSections: [...next] });
              }} />
              {SECTION_TITLES[s]}
            </label>
          ))}
        </fieldset>
        <fieldset className="source-prefs">
          <legend>Sources ({sources.length - sources.filter((s) => disabled.has(s.id)).length} of {sources.length} on)</legend>
          <label htmlFor="srcfilter" className="sr-only">Filter sources</label>
          <input id="srcfilter" type="search" placeholder="Filter sources" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {SECTIONS.map((sec) => {
            const list = sources.filter((s) => s.section === sec && (!f || s.name.toLowerCase().includes(f)));
            if (list.length === 0) return null;
            return (
              <div key={sec} className="source-group">
                <h3>{SECTION_TITLES[sec]}</h3>
                {list.map((s) => (
                  <label key={s.id} className="choice">
                    <input type="checkbox" checked={!disabled.has(s.id)} onChange={() => toggleSource(s.id)} />
                    {s.name} <span className="cc">{s.country}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </fieldset>
        <button type="button" className="text-btn" onClick={() => onChange(DEFAULT_PREFS)}>Reset to defaults</button>
      </div>
    </div>
  );
}

export function SearchResults({ query, ctx, filters, onFilters, onClear }: {
  query: string; ctx: Ctx; filters: SearchFilters; onFilters: (f: SearchFilters) => void; onClear: () => void;
}) {
  const r = useMemo(() => searchArticles(ctx.view, ctx.sources, query, filters, ctx.nowMs, (s) => SECTION_TITLES[s]),
    [query, ctx, filters]);
  const set = <K extends keyof SearchFilters>(k: K, v: SearchFilters[K]) => onFilters({ ...filters, [k]: v });
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);
  const count = r.total > RESULT_LIMIT ? `${RESULT_LIMIT} of ${r.total}` : String(r.total);
  return (
    <section className="search-results" aria-labelledby="sr-h">
      <div className="band-head">
        <h2 id="sr-h" className="band-title" aria-live="polite">{count} {r.total === 1 ? 'headline' : 'headlines'} matching "{query}"</h2>
        <button type="button" className="text-btn" onClick={onClear}>Clear search</button>
      </div>
      <form className="filters" aria-label="Filter results" onSubmit={(e) => e.preventDefault()}>
        <label>Section
          <select value={filters.section} onChange={(e) => set('section', e.target.value as SearchFilters['section'])}>
            <option value="all">All sections</option>
            {r.facets.sections.map((f) => <option key={f.value} value={f.value}>{f.label} ({f.count})</option>)}
          </select>
        </label>
        <label>Source
          <select value={filters.source} onChange={(e) => set('source', e.target.value)}>
            <option value="all">All sources</option>
            {r.facets.sources.map((f) => <option key={f.value} value={f.value}>{f.label} ({f.count})</option>)}
          </select>
        </label>
        <label>Country
          <select value={filters.country} onChange={(e) => set('country', e.target.value)}>
            <option value="all">All countries</option>
            {r.facets.countries.map((f) => <option key={f.value} value={f.value}>{f.label} ({f.count})</option>)}
          </select>
        </label>
        <label>Published
          <select value={filters.within} onChange={(e) => set('within', e.target.value as Within)}>
            <option value="any">Any time</option>
            <option value="6h">Last 6 hours</option>
            <option value="24h">Last 24 hours</option>
            <option value="48h">Last 48 hours</option>
          </select>
        </label>
        <label>Sort
          <select value={filters.sort} onChange={(e) => set('sort', e.target.value as SortOrder)}>
            <option value="newest">Newest first</option>
            <option value="coverage">Most outlets first</option>
          </select>
        </label>
        {filtered && <button type="button" className="text-btn" onClick={() => onFilters(DEFAULT_FILTERS)}>Reset filters</button>}
      </form>
      {r.total === 0 && r.matched > 0 && <p className="notice">No headlines match these filters. {r.matched} match the search alone.</p>}
      <ul className="stories">
        {r.results.map((a) => (
          <li className="story" key={a.id}>
            <a className="headline" href={a.url} rel="noopener noreferrer" target="_blank">{a.title}</a>
            <div className="story-meta"><span className="section-tag">{SECTION_TITLES[a.section]}</span><Meta a={a} ctx={ctx} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}
