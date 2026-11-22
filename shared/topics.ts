// Light topic signals for ranking news columns. Nothing is hidden: items that are not news
// stories in the sense of the three news columns (sports results, personal advice columns,
// programming notes and roundups, reviews) simply rank lower, by a fixed factor that the
// methodology page states. Matching is on the headline only and deliberately narrow.

export type SoftTopic = 'sports' | 'advice' | 'programming' | 'review';

const SPORTS = new RegExp([
  'NFL', 'NBA', 'WNBA', 'MLB', 'NHL', 'NWSL', 'MLS', 'NCAA', 'UFC', 'Formula 1', 'F1',
  'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League', 'Europa League',
  'Super Bowl', 'World Series', 'Stanley Cup', 'Grand Slam', 'Wimbledon', 'Ryder Cup', 'Grand Prix',
  'quarterback', 'touchdown', 'goalkeeper', 'hat-trick', 'innings', 'wicket', 'playoffs?', 'semifinals?',
].map((w) => w.replace(/ /g, '\\s+')).join('|').replace(/^/, '\\b(?:').concat(')\\b'), 'i');

// "My husband ... Is he being fair?", "Ask Amy:", "Dear Abby".
const ADVICE = /^(?:(?:my|our)\s+(?:husband|wife|partner|boyfriend|girlfriend|boss|son|daughter|mother|father|mom|dad|parents?|sister|brother|friend|neighbou?r|landlord|family|in-laws?)\b.*\?\s*$|ask\s+\w+\s*:|dear\s+\w+\s*:)/i;

// Schedules, roundups and galleries rather than stories.
const PROGRAMMING = /^(?:this\s+week\s+on\b|coming\s+up\s+on\b|news\s+in\s+frames\b|in\s+pictures\b|photos?\s*:|quiz\s*:|crossword\b|wordle\b|horoscopes?\b)|\bwhat\s+happened\s+in\s+\w+\s+today\b|^here.s\s+what\s+happened\b/i;

const REVIEW = /^review\s*:|\breview\s*:\s/i;

// A reader's own question: "Should I accept a lower pension ...?", "... What can I do?"
const FIRST_PERSON_QUESTION = /\b(?:should|can|do|am|must|could|would)\s+I\b[^?]*\?\s*$/i;

export function softTopic(title: string): SoftTopic | null {
  const t = title.trim();
  if (ADVICE.test(t) || FIRST_PERSON_QUESTION.test(t)) return 'advice';
  if (PROGRAMMING.test(t)) return 'programming';
  if (REVIEW.test(t)) return 'review';
  if (SPORTS.test(t)) return 'sports';
  return null;
}

/** Ranking factor in news columns. */
export const SOFT_FACTOR: Record<SoftTopic, number> = { sports: 0.35, advice: 0.35, programming: 0.35, review: 0.6 };

export function softFactor(title: string): number {
  const s = softTopic(title);
  return s ? SOFT_FACTOR[s] : 1;
}
