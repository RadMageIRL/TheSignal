// Place names used to sort world headlines into regions and to keep stories about
// different places from being grouped together. No imports from cluster.ts (cycle-free).
import type { Subsection } from './types.ts';
import { stem } from './stem.ts';

export const REGIONS: [Subsection, string][] = [
  ['europe', 'europe european eu brussels nato ukraine ukrainian kyiv kiev zelensky zelenskyy russia russian moscow kremlin putin ' +
    'belarus minsk poland polish warsaw germany german berlin merz france french paris macron britain british uk london starmer ' +
    'england scotland wales ireland irish dublin italy italian rome meloni spain spanish madrid portugal lisbon netherlands dutch ' +
    'amsterdam belgium belgian sweden swedish stockholm norway norwegian oslo finland finnish helsinki denmark danish copenhagen ' +
    'greenland greece greek athens hungary hungarian budapest orban austria vienna switzerland swiss czech prague slovakia romania ' +
    'bulgaria serbia serbian belgrade croatia bosnia kosovo albania moldova tbilisi baltic estonia latvia lithuania vatican pope'],
  ['mideast', 'israel israeli gaza hamas hezbollah lebanon lebanese beirut syria syrian damascus iran iranian tehran iraq iraqi baghdad ' +
    'saudi riyadh yemen houthi houthis qatar doha uae emirates dubai abu dhabi amman egypt egyptian cairo turkiye turkish ankara hormuz ' +
    'erdogan istanbul kuwait bahrain oman palestinian palestinians netanyahu jerusalem tel aviv west bank kurdish kurds'],
  ['asia', 'china chinese beijing xi shanghai hong kong taiwan taiwanese taipei japan japanese tokyo korea korean seoul pyongyang ' +
    'india indian delhi modi mumbai pakistan pakistani islamabad karachi afghanistan afghan kabul taliban bangladesh dhaka sri lanka ' +
    'nepal myanmar burma thailand thai bangkok vietnam vietnamese hanoi cambodia laos malaysia malaysian kuala lumpur singapore ' +
    'indonesia indonesian jakarta philippines philippine filipino manila marcos australia australian canberra sydney melbourne albanese ' +
    'zealand wellington auckland pacific fiji papua kazakhstan uzbekistan mongolia asean'],
  ['africa-americas', 'africa african nigeria nigerian abuja lagos kenya kenyan nairobi ethiopia ethiopian addis sudan sudanese khartoum ' +
    'somalia congo kinshasa uganda tanzania rwanda ghana senegal mali niger burkina cameroon angola mozambique zimbabwe zambia ' +
    'south africa johannesburg pretoria ramaphosa morocco algeria tunisia libya sahel canada canadian ottawa carney toronto mexico ' +
    'mexican sheinbaum brazil brazilian brasilia lula argentina argentine milei buenos aires chile chilean colombia colombian bogota ' +
    'venezuela venezuelan maduro caracas peru lima ecuador bolivia paraguay uruguay cuba cuban havana haiti haitian caribbean panama ' +
    'guatemala honduras nicaragua salvador'],
];

export const US_WORDS = new Set((
  'alabama alaska arizona arkansas california colorado connecticut delaware florida hawaii idaho illinois indiana iowa kansas ' +
  'kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada ohio oklahoma ' +
  'oregon pennsylvania tennessee texas utah vermont virginia wisconsin wyoming chicago houston phoenix philadelphia seattle ' +
  'boston atlanta miami denver detroit portland baltimore milwaukee albuquerque minneapolis nashville memphis louisville ' +
  'fbi ice congress senate senator senators congressional republicans democrats gop scotus medicaid medicare'
).split(' '));

export const US_PHRASES = ['new york', 'los angeles', 'san francisco', 'las vegas', 'new jersey', 'new mexico', 'north carolina', 'south carolina', 'north dakota', 'south dakota', 'west virginia', 'rhode island', 'new hampshire', 'supreme court', 'white house', 'washington dc'];

/** Every single place word, stemmed the way the tokenizer stems headline words. */
export const PLACE_TOKENS: Set<string> = (() => {
  const out = new Set<string>();
  const add = (w: string) => { if (w.length >= 3 && !['new', 'south', 'north', 'west', 'east', 'sri', 'san', 'los', 'las', 'tel', 'abu', 'el'].includes(w)) out.add(stem(w)); };
  for (const [, words] of REGIONS) for (const w of words.split(/\s+/)) if (w) add(w);
  for (const w of US_WORDS) if (!['fbi', 'ice', 'congress', 'senate', 'senator', 'senators', 'congressional', 'republicans', 'democrats', 'gop', 'scotus', 'medicaid', 'medicare'].includes(w)) add(w);
  for (const p of US_PHRASES) for (const w of p.split(' ')) if (!['supreme', 'court', 'white', 'house'].includes(w)) add(w);
  for (const w of ['nato', 'eu', 'asean', 'pope', 'vatican', 'kremlin', 'taliban', 'hamas', 'hezbollah', 'houthi', 'houthis', 'putin', 'xi', 'modi', 'netanyahu', 'zelensky', 'zelenskyy', 'erdogan', 'macron', 'meloni', 'orban', 'lula', 'milei', 'maduro', 'carney', 'albanese', 'marcos', 'ramaphosa', 'sheinbaum', 'starmer', 'merz']) out.delete(stem(w));
  return out;
})();

// Adjectives of nationality and a few common variants, mapped to one canonical place word,
// so "Mexican" and "Mexico" (or "Ukrainian" and "Kyiv"'s country) are not read as different places.
const SAME_PLACE: Record<string, string> = {
  mexican: 'mexico', russian: 'russia', ukrainian: 'ukraine', chinese: 'china', israeli: 'israel', iranian: 'iran',
  iraqi: 'iraq', syrian: 'syria', lebanese: 'lebanon', egyptian: 'egypt', turkish: 'turkey', saudi: 'saudi',
  palestinian: 'palestine', japanese: 'japan', korean: 'korea', indian: 'india', pakistani: 'pakistan', afghan: 'afghanistan',
  thai: 'thailand', vietnamese: 'vietnam', malaysian: 'malaysia', indonesian: 'indonesia', philippine: 'philippines',
  filipino: 'philippines', australian: 'australia', canadian: 'canada', brazilian: 'brazil', argentine: 'argentina',
  chilean: 'chile', colombian: 'colombia', venezuelan: 'venezuela', cuban: 'cuba', haitian: 'haiti', nigerian: 'nigeria',
  kenyan: 'kenya', ethiopian: 'ethiopia', sudanese: 'sudan', german: 'germany', french: 'france', british: 'britain',
  uk: 'britain', england: 'britain', irish: 'ireland', italian: 'italy', spanish: 'spain', polish: 'poland', dutch: 'netherlands',
  belgian: 'belgium', swedish: 'sweden', norwegian: 'norway', finnish: 'finland', danish: 'denmark', greek: 'greece',
  hungarian: 'hungary', serbian: 'serbia', european: 'europe', african: 'africa', taiwanese: 'taiwan', kurd: 'kurdish',
};

/** One canonical token per place, so variants of the same place compare equal. */
export function canonicalPlace(token: string): string {
  return SAME_PLACE[token] ? stem(SAME_PLACE[token]) : token;
}
