// Rules for the source registry (registry/sources.json). The registry records, per source, what
// its terms allow; these functions turn that into what The Signal may do, and check the file for
// mistakes that would let a source through without permission.
import type { Permission, SourceEntry, SourceStatus, PublicSource } from './types.ts';
import { SECTION_SUBS } from './layout.ts';
import { COUNTRY_NAMES } from './countries.ts';

const STATUSES: SourceStatus[] = ['READY', 'RESEARCH', 'CONDITIONAL', 'DEFERRED', 'UNAVAILABLE'];
const PERMISSIONS: Permission[] = ['yes', 'no', 'unknown'];
const KINDS = ['rss', 'podcast', 'hn-rss', 'mastodon-links', 'wikipedia-top', 'json-feed'];
const AFFILIATIONS = ['private', 'public-broadcaster', 'state', 'government', 'intergovernmental', 'nonprofit', 'independent', 'cooperative', 'community', 'unknown'];
const TYPES = ['reporting', 'wire', 'opinion', 'commentary', 'investigation', 'official', 'podcast', 'video', 'community', 'mixed'];

/** The headline, publisher, time and link may appear on the public website. */
export function mayDisplay(s: Pick<SourceEntry, 'status' | 'rights'>): boolean {
  return s.status === 'READY' && s.rights.display === 'yes';
}

/** The same may also be redistributed through The Signal's outgoing RSS feeds. */
export function maySyndicate(s: Pick<SourceEntry, 'status' | 'rights'>): boolean {
  return mayDisplay(s) && s.rights.syndication === 'yes';
}

/** Sources the collector may fetch in production. */
export function collectable(list: SourceEntry[]): SourceEntry[] {
  return list.filter((s) => s.enabled && mayDisplay(s) && s.gates.length === 0 && s.feeds.length > 0);
}

export function toPublicSource(s: SourceEntry): PublicSource {
  const { id, name, homepage, country, region, language, section, contentType, affiliation, ownership, attribution, notice, network } = s;
  const p: PublicSource = { id, name, homepage, country, region, language, section, contentType, affiliation, ownership, attribution, syndicate: maySyndicate(s) };
  if (notice) p.notice = notice;
  if (network) p.network = network;
  return p;
}

function httpsUrl(u: string): boolean {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

/** Every problem in the registry, as readable strings. An empty list means the file is sound. */
export function validateRegistry(list: SourceEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const feedUrls = new Set<string>();
  for (const s of list) {
    const at = `${s.id ?? '?'}:`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id ?? '')) out.push(`${at} id must be lowercase words joined by hyphens`);
    if (seen.has(s.id)) out.push(`${at} duplicate id`);
    seen.add(s.id);
    if (!s.name?.trim()) out.push(`${at} name is empty`);
    if (!httpsUrl(s.homepage)) out.push(`${at} homepage must be an https URL`);
    if (!(s.country in COUNTRY_NAMES)) out.push(`${at} unknown country code ${s.country}`);
    if (!(s.section in SECTION_SUBS)) out.push(`${at} unknown section ${s.section}`);
    if (!TYPES.includes(s.contentType)) out.push(`${at} unknown content type ${s.contentType}`);
    if (!AFFILIATIONS.includes(s.affiliation)) out.push(`${at} unknown affiliation ${s.affiliation}`);
    if (!STATUSES.includes(s.status)) out.push(`${at} unknown status ${s.status}`);
    if (!Number.isInteger(s.intervalMinutes) || s.intervalMinutes < 15 || s.intervalMinutes > 1440) out.push(`${at} intervalMinutes must be a whole number from 15 to 1440`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.reviewed ?? '')) out.push(`${at} reviewed must be a YYYY-MM-DD date`);
    if (s.notice !== undefined && (!s.notice.trim() || s.notice.length > 400)) out.push(`${at} notice must be 1 to 400 characters`);
    if (s.network !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.network)) out.push(`${at} network must be lowercase words joined by hyphens`);
    if (!s.rights) {
      out.push(`${at} rights are missing`);
    } else {
      for (const k of ['display', 'syndication', 'excerpt', 'images'] as const) {
        if (!PERMISSIONS.includes(s.rights[k])) out.push(`${at} rights.${k} must be yes, no or unknown`);
      }
      if (s.rights.syndication === 'yes' && s.rights.display !== 'yes') out.push(`${at} syndication cannot be allowed when display is not`);
    }
    if (s.status === 'READY') {
      if (!s.attribution?.trim()) out.push(`${at} READY sources must record the attribution required (or "none stated")`);
      if (s.rights?.display !== 'yes') out.push(`${at} READY requires rights.display = yes`);
    }
    if (s.enabled) {
      if (s.status !== 'READY') out.push(`${at} only READY sources may be enabled`);
      if (s.gates.length > 0) out.push(`${at} cannot be enabled while gates remain: ${s.gates.join('; ')}`);
      if (s.feeds.length === 0) out.push(`${at} enabled without a feed`);
    }
    for (const f of s.feeds ?? []) {
      if (!KINDS.includes(f.kind)) out.push(`${at} unknown feed kind ${f.kind}`);
      const sec = f.section ?? s.section;
      if (!(SECTION_SUBS[sec] ?? []).includes(f.subsection)) out.push(`${at} feed subsection ${f.subsection} is not in section ${sec}`);
      const plain = f.url.replace(/\{[YMD]\}/g, '1');
      try {
        const u = new URL(plain);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') out.push(`${at} feed URL scheme must be http(s)`);
        if (u.username || u.password) out.push(`${at} feed URL must not carry credentials`);
      } catch {
        out.push(`${at} feed URL does not parse: ${f.url}`);
      }
      if (feedUrls.has(f.url)) out.push(`${at} feed URL listed twice: ${f.url}`);
      feedUrls.add(f.url);
    }
  }
  return out;
}
