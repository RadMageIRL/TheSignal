// Labels a publisher puts on its own headline: "Opinion:", "Commentary |", "... - opinion",
// "[Sponsored]", "Sponsored Commentary:". Only a label in the label's place counts: at the start
// of the headline followed by a separator, or at the end after one (or in brackets). A word
// inside a headline never does, so "Public opinion turns against the plan" or "Senate passes a
// bill sponsored by Smith" are ordinary headlines.
//
// Used in two ways, both stated on the methodology page:
// - opinion and commentary labels make an item from a news feed rank as opinion or commentary,
//   and keep it from being the lead story (it still appears in its column);
// - a sponsored label leaves the item out: it is advertising, not the publisher's journalism.
import type { Article } from './types.ts';

export type HeadlineLabel = 'opinion' | 'commentary' | 'sponsored';

// En and em dash, as some feeds write them (built from code points so the source stays ASCII).
const DASHES = String.fromCharCode(0x2013, 0x2014);

const WORDS: Record<HeadlineLabel, string> = {
  sponsored: 'sponsored(?:\\s+(?:commentary|content|post|article|story|feature))?|paid\\s+(?:post|content|partnership|promotion)|partner\\s+content|advertorial|advertisement',
  commentary: 'commentary',
  opinion: 'opinion|op-ed|op\\s+ed|editorial',
};

function labelPattern(words: string): RegExp {
  const start = `^\\s*(?:\\[(?:${words})\\]|(?:${words})\\s*[:|]|(?:${words})\\s+[-${DASHES}]\\s)`;
  const end = `(?:\\s[-${DASHES}|]\\s*(?:${words})|\\s*[(\\[](?:${words})[)\\]])\\s*\\.?\\s*$`;
  return new RegExp(`${start}|${end}`, 'i');
}

// Checked in this order: "Sponsored Commentary:" is sponsored, not commentary.
const PATTERNS: [HeadlineLabel, RegExp][] = (['sponsored', 'commentary', 'opinion'] as const).map((l) => [l, labelPattern(WORDS[l])]);

/** The label the publisher put on this headline, if any. */
export function headlineLabel(title: string): HeadlineLabel | null {
  for (const [label, re] of PATTERNS) if (re.test(title)) return label;
  return null;
}

/** True for an item its publisher labels as sponsored or paid content. */
export function isSponsored(title: string): boolean {
  return headlineLabel(title) === 'sponsored';
}

const OPINION_TYPES = new Set(['opinion', 'commentary']);

/** The content type used for ranking: the headline's own opinion or commentary label, else the source's type. */
export function effectiveType(a: Pick<Article, 'title' | 'contentType'>): string {
  if (OPINION_TYPES.has(a.contentType)) return a.contentType;
  const l = headlineLabel(a.title);
  return l === 'opinion' || l === 'commentary' ? l : a.contentType;
}

/** True when an item is opinion or commentary, by its source's type or its own label. */
export function isOpinion(a: Pick<Article, 'title' | 'contentType'>): boolean {
  return OPINION_TYPES.has(effectiveType(a));
}
