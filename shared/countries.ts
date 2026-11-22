// Country names for the ISO 3166-1 codes the registry uses ("INT" = multinational, "EU" = European Union).
export const COUNTRY_NAMES: Record<string, string> = {
  AE: 'United Arab Emirates', AF: 'Afghanistan', AL: 'Albania', AM: 'Armenia', AO: 'Angola',
  AR: 'Argentina', AT: 'Austria', AU: 'Australia', AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina',
  BD: 'Bangladesh', BE: 'Belgium', BG: 'Bulgaria', BH: 'Bahrain', BO: 'Bolivia',
  BR: 'Brazil', BW: 'Botswana', BY: 'Belarus', CA: 'Canada', CD: 'DR Congo',
  CH: 'Switzerland', CI: "Cote d'Ivoire", CL: 'Chile', CM: 'Cameroon', CN: 'China',
  CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CY: 'Cyprus', CZ: 'Czechia',
  DE: 'Germany', DK: 'Denmark', DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador',
  EE: 'Estonia', EG: 'Egypt', ES: 'Spain', ET: 'Ethiopia', EU: 'European Union',
  FI: 'Finland', FJ: 'Fiji', FR: 'France', GB: 'United Kingdom', GE: 'Georgia',
  GH: 'Ghana', GR: 'Greece', GT: 'Guatemala', HK: 'Hong Kong', HN: 'Honduras',
  HR: 'Croatia', HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland',
  IL: 'Israel', IN: 'India', INT: 'International', IQ: 'Iraq', IR: 'Iran',
  IS: 'Iceland', IT: 'Italy', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan',
  KE: 'Kenya', KG: 'Kyrgyzstan', KH: 'Cambodia', KR: 'South Korea', KW: 'Kuwait',
  KZ: 'Kazakhstan', LB: 'Lebanon', LK: 'Sri Lanka', LT: 'Lithuania', LU: 'Luxembourg',
  LV: 'Latvia', LY: 'Libya', MA: 'Morocco', MD: 'Moldova', ME: 'Montenegro',
  MG: 'Madagascar', MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia',
  MT: 'Malta', MW: 'Malawi', MX: 'Mexico', MY: 'Malaysia', MZ: 'Mozambique',
  NA: 'Namibia', NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway',
  NP: 'Nepal', NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru',
  PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PR: 'Puerto Rico',
  PS: 'Palestinian Territories', PT: 'Portugal', PY: 'Paraguay', QA: 'Qatar', RO: 'Romania',
  RS: 'Serbia', RU: 'Russia', RW: 'Rwanda', SA: 'Saudi Arabia', SD: 'Sudan',
  SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia', SN: 'Senegal',
  SO: 'Somalia', SS: 'South Sudan', SV: 'El Salvador', SY: 'Syria', TH: 'Thailand',
  TJ: 'Tajikistan', TN: 'Tunisia', TR: 'Turkey', TT: 'Trinidad and Tobago', TW: 'Taiwan',
  TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda', US: 'United States', UY: 'Uruguay',
  UZ: 'Uzbekistan', VE: 'Venezuela', VN: 'Vietnam', WS: 'Samoa', XK: 'Kosovo', YE: 'Yemen',
  ZA: 'South Africa', ZM: 'Zambia', ZW: 'Zimbabwe',
};

export function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}

export const AFFILIATION_LABEL: Record<string, string> = {
  state: 'State-affiliated',
  'public-broadcaster': 'Public broadcaster',
  government: 'Government',
  intergovernmental: 'Intergovernmental',
  nonprofit: 'Nonprofit',
  independent: 'Independent',
  cooperative: 'Cooperative',
  community: 'Community',
  private: 'Private',
  unknown: 'Unknown',
};

export const TYPE_LABEL: Record<string, string> = {
  reporting: 'Reporting', wire: 'Wire', opinion: 'Opinion', commentary: 'Commentary',
  investigation: 'Investigation', official: 'Official', podcast: 'Podcast', video: 'Video',
  community: 'Community', mixed: 'Reporting and commentary',
};
