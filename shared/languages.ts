// Headline languages. The Signal shows every headline exactly as its publisher wrote it and
// never translates one; for headlines not in English it says which language they are in, marks
// them up so browsers and screen readers handle the script and direction correctly, and lets
// readers filter by language. Story grouping reads English headlines only (shared/cluster.ts),
// so headlines in other languages are listed on their own until multilingual grouping exists.

/** English names for the primary language subtags of BCP 47 tags used by registry sources. */
const NAMES: Record<string, string> = {
  ar: 'Arabic', bn: 'Bengali', de: 'German', el: 'Greek', en: 'English', es: 'Spanish', fa: 'Persian', fi: 'Finnish',
  fr: 'French', he: 'Hebrew', hi: 'Hindi', hu: 'Hungarian', id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean',
  ms: 'Malay', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', ru: 'Russian', sv: 'Swedish', sw: 'Swahili', th: 'Thai',
  tl: 'Tagalog', tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu', vi: 'Vietnamese', zh: 'Chinese',
};

const SCRIPTS: Record<string, string> = { hans: 'Simplified', hant: 'Traditional' };

/** "pt-BR" -> "pt". */
export function primaryLanguage(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

export function isEnglish(tag: string): boolean {
  return primaryLanguage(tag) === 'en';
}

/** True when languageName can name this tag (the registry check requires it for every source). */
export function knownLanguage(tag: string): boolean {
  return primaryLanguage(tag) in NAMES;
}

/**
 * The language's English name, with the script when the tag gives one ("zh-Hant-TW" ->
 * "Chinese (Traditional)"). Regions are left out: the publisher's country is shown separately.
 * An unknown tag is shown as the tag itself rather than guessed.
 */
export function languageName(tag: string): string {
  const parts = tag.split('-');
  const base = NAMES[primaryLanguage(tag)];
  if (!base) return tag;
  const script = parts.slice(1).find((p) => p.length === 4 && SCRIPTS[p.toLowerCase()]);
  return script ? `${base} (${SCRIPTS[script.toLowerCase()]})` : base;
}

/**
 * Attributes for an element holding a headline. English headlines inherit the page's language;
 * any other headline declares its own, and its direction is left to the browser ("auto"), which
 * reads it from the text itself (Arabic, for example, runs right to left).
 */
export function headlineLangAttrs(tag: string): { lang?: string; dir?: 'auto' } {
  return isEnglish(tag) ? {} : { lang: tag, dir: 'auto' };
}
