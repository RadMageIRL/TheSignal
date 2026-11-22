import { useEffect, useState } from 'react';
import type { WireSnapshot } from '../../shared/wire.ts';
import { absoluteTime, longDate, relativeTime } from '../lib/time.ts';
import { RssIcon } from './Rss.tsx';
import { SupportLinks } from './Support.tsx';

export const NAV: { id: string; label: string; href: string }[] = [
  { id: 'us', label: 'U.S. & Politics', href: '#us' },
  { id: 'world', label: 'World', href: '#world' },
  { id: 'markets', label: 'Markets & Tech', href: '#markets' },
  { id: 'perspectives', label: 'Global Perspectives', href: '#perspectives' },
  { id: 'outside', label: 'Outside the Mainstream', href: '#outside' },
  { id: 'airwaves', label: 'The Airwaves', href: '#airwaves' },
  { id: 'pulse', label: "The People's Pulse", href: '#pulse' },
  { id: 'sources', label: 'Sources', href: '#/sources' },
  { id: 'about', label: 'Methodology', href: '#/about' },
];

function Icon({ d, label }: { d: string; label: string }) {
  return (
    <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <title>{label}</title>
      <path d={d} />
    </svg>
  );
}
const SEARCH = 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM21 21l-4.3-4.3';
const SUN = 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4';
const MOON = 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z';
const SLIDERS = 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6';

/** Freshness of the snapshot, said plainly. A prototype capture never claims to be live. */
export function Status({ wire, nowMs }: { wire: WireSnapshot; nowMs: number }) {
  const ageMin = (nowMs - Date.parse(wire.generatedAt)) / 60_000;
  let cls = 'status-live';
  let text = `Updated ${relativeTime(wire.generatedAt, nowMs)}`;
  if (wire.mode === 'prototype') {
    cls = 'status-proto';
    text = `Prototype capture, ${absoluteTime(wire.generatedAt)}`;
  } else if (ageMin > 360) {
    cls = 'status-down';
    text = `Collection paused: showing the last good update, ${relativeTime(wire.generatedAt, nowMs)}`;
  } else if (ageMin > 45) {
    cls = 'status-stale';
    text = `Last updated ${relativeTime(wire.generatedAt, nowMs)}`;
  }
  return (
    <span className={`status ${cls}`} role="status" title={absoluteTime(wire.generatedAt)}>
      <span className="dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function TopBar(props: {
  wire: WireSnapshot | null;
  query: string;
  onQuery: (q: string) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onPrefs: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="today">{longDate(now)}</span>
        {props.wire && <Status wire={props.wire} nowMs={now} />}
        <SupportLinks place="top" />
      </div>
      <div className="topbar-right">
        <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="q" className="sr-only">Search headlines</label>
          <Icon d={SEARCH} label="Search" />
          <input id="q" type="search" placeholder="Search headlines" autoComplete="off" spellCheck={false}
            value={props.query} onChange={(e) => props.onQuery(e.target.value)} maxLength={80} />
        </form>
        <a className="icon-btn" href="#/feeds" aria-label="RSS feeds" title="RSS feeds"><RssIcon size={16} /></a>
        <button type="button" className="icon-btn" onClick={props.onToggleTheme}
          aria-label={props.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <Icon d={props.theme === 'dark' ? SUN : MOON} label="Theme" />
        </button>
        <button type="button" className="icon-btn" onClick={props.onPrefs} aria-label="Preferences">
          <Icon d={SLIDERS} label="Preferences" />
        </button>
      </div>
    </div>
  );
}

export function Masthead() {
  return (
    <header className="masthead">
      <a href="#/" className="masthead-link" aria-label="The Signal, home">
        <span className="masthead-the">The</span>{' '}
        <span className="masthead-name">Signal</span>
      </a>
      <p className="tagline">One world. Many perspectives. Draw your own conclusions.</p>
    </header>
  );
}

export function Nav({ hidden }: { hidden: Set<string> }) {
  return (
    <nav className="nav" aria-label="Sections">
      <ul>
        {NAV.filter((n) => !hidden.has(n.id)).map((n) => (
          <li key={n.id}><a href={n.href}>{n.label}</a></li>
        ))}
      </ul>
    </nav>
  );
}
