// Reader preferences, kept only in this browser. Storage can be unavailable (private
// windows, blocked site data); every read and write is guarded and the page works without it.
import type { SectionId } from '../../shared/types.ts';

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'compact' | 'comfortable';

export interface Prefs {
  v: 1;
  theme: Theme;
  density: Density;
  hiddenSections: SectionId[];
  disabledSources: string[];
}

export const DEFAULT_PREFS: Prefs = { v: 1, theme: 'dark', density: 'compact', hiddenSections: [], disabledSources: [] };

const KEY = 'the-signal:prefs:v1';
const SECTIONS: SectionId[] = ['us', 'world', 'markets', 'outside', 'airwaves', 'pulse'];

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      v: 1,
      theme: p.theme === 'light' || p.theme === 'system' ? p.theme : 'dark',
      density: p.density === 'comfortable' ? 'comfortable' : 'compact',
      hiddenSections: Array.isArray(p.hiddenSections) ? p.hiddenSections.filter((s): s is SectionId => SECTIONS.includes(s as SectionId)) : [],
      disabledSources: Array.isArray(p.disabledSources) ? p.disabledSources.filter((s) => typeof s === 'string').slice(0, 500) : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: preferences last for this visit only */
  }
}

export function resolvedTheme(t: Theme): 'dark' | 'light' {
  if (t !== 'system') return t;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
