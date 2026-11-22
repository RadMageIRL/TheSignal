// Relative and absolute timestamps. Absolute times use the reader's own time zone.

export function relativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const diff = Math.max(0, nowMs - Date.parse(iso));
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

export function shortAge(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const ABS = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

export function absoluteTime(iso: string | null): string {
  if (!iso) return 'Time not given by the publisher';
  return ABS.format(new Date(iso));
}

export function longDate(ms: number): string {
  return DAY.format(new Date(ms));
}

export function duration(sec?: number): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
