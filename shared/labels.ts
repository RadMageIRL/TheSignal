// Human-readable names for sections and lists, shared by the page and the RSS feeds.
import type { SectionId, Subsection } from './types.ts';

export const SECTION_TITLES: Record<SectionId, string> = {
  us: 'U.S. & Politics',
  world: 'World News',
  markets: 'Markets & Technology',
  outside: 'Outside the Mainstream',
  airwaves: 'The Airwaves',
  pulse: "The People's Pulse",
};

export const SUB_TITLES: Record<Subsection, string> = {
  national: 'National', washington: 'Washington', law: 'Law & Government', economy: 'Domestic Economy',
  'world-general': 'Around the World', europe: 'Europe & Russia', mideast: 'Middle East', asia: 'Asia & Pacific',
  'africa-americas': 'Africa & the Americas', 'global-markets': 'Global Markets', crypto: 'Cryptocurrency',
  tech: 'Technology & AI', science: 'Science & Space', alternative: 'Alternative Media',
  independent: 'Independent Journalism', investigations: 'Investigations', commentary: 'Commentary',
  podcasts: 'Latest Episodes', interviews: 'Long-form Interviews', video: 'Independent Video',
  discussions: 'Discussions', trends: 'Emerging Conversations', reading: 'What People Are Reading',
};

export const SECTION_ORDER: SectionId[] = ['us', 'world', 'markets', 'outside', 'airwaves', 'pulse'];
