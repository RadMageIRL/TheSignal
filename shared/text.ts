// Text handling for untrusted feed content. Feed titles arrive as XML text that may still
// carry HTML markup or HTML entities (often double encoded). Everything leaves here as plain
// text; nothing downstream ever renders it as HTML.

// Code points, not literal characters, so this file stays ASCII.
const NAMED: Record<string, number> = {
  amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0,
  lsquo: 0x2018, rsquo: 0x2019, sbquo: 0x201a, ldquo: 0x201c, rdquo: 0x201d, bdquo: 0x201e,
  ndash: 0x2013, mdash: 0x2014, hellip: 0x2026, bull: 0x2022, middot: 0xb7, prime: 0x2032,
  laquo: 0xab, raquo: 0xbb, copy: 0xa9, reg: 0xae, trade: 0x2122, deg: 0xb0, euro: 0x20ac,
  pound: 0xa3, yen: 0xa5, cent: 0xa2, times: 0xd7, divide: 0xf7, plusmn: 0xb1, frac12: 0xbd,
  eacute: 0xe9, egrave: 0xe8, ecirc: 0xea, euml: 0xeb, aacute: 0xe1, agrave: 0xe0, acirc: 0xe2,
  auml: 0xe4, atilde: 0xe3, aring: 0xe5, ccedil: 0xe7, iacute: 0xed, igrave: 0xec, icirc: 0xee,
  iuml: 0xef, ntilde: 0xf1, oacute: 0xf3, ograve: 0xf2, ocirc: 0xf4, ouml: 0xf6, otilde: 0xf5,
  oslash: 0xf8, uacute: 0xfa, ugrave: 0xf9, ucirc: 0xfb, uuml: 0xfc, yacute: 0xfd, szlig: 0xdf,
  Eacute: 0xc9, Aacute: 0xc1, Oacute: 0xd3, Uacute: 0xda, Iacute: 0xcd, Ntilde: 0xd1, Uuml: 0xdc,
  Ouml: 0xd6, Auml: 0xc4, Ccedil: 0xc7, zwj: 0x200d, zwnj: 0x200c, shy: 0xad, thinsp: 0x2009,
  ensp: 0x2002, emsp: 0x2003,
};

const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi;

function decodeOnce(s: string): string {
  return s.replace(ENTITY, (m, body: string) => {
    let cp: number | undefined;
    if (body[0] === '#') {
      cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    } else {
      cp = NAMED[body] ?? NAMED[body.toLowerCase()];
    }
    if (cp === undefined || !Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
    if (cp >= 0xd800 && cp <= 0xdfff) return m;
    return String.fromCodePoint(cp);
  });
}

/** Decode HTML entities, up to three layers deep (feeds double encode surprisingly often). */
export function decodeEntities(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

// Control characters other than tab/newline, plus bidi overrides that can disguise text.
const CONTROL_RANGES: [number, number][] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x202a, 0x202e], [0x2066, 0x2069],
];
const hex4 = (n: number) => String.fromCharCode(92) + 'u' + n.toString(16).padStart(4, '0');
const CONTROL = new RegExp('[' + CONTROL_RANGES.map(([a, b]) => hex4(a) + '-' + hex4(b)).join('') + ']', 'g');

/** Untrusted feed text to a single clean line of plain text. */
export function cleanText(raw: unknown, maxLen = 300): string {
  if (raw === null || raw === undefined) return '';
  let s = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  if (!s && typeof raw === 'object' && raw !== null && '#text' in raw) {
    s = String((raw as Record<string, unknown>)['#text'] ?? '');
  }
  s = decodeEntities(s);
  s = s.replace(/<!\[CDATA\[|\]\]>/g, '');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s); // markup removed above may have hidden one more layer
  s = s.replace(/[<>]/g, ' ');
  s = s.replace(CONTROL, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen);
    const sp = cut.lastIndexOf(' ');
    s = (sp > maxLen * 0.6 ? cut.slice(0, sp) : cut) + String.fromCodePoint(0x2026);
  }
  return s;
}

/** Parse an RSS/Atom/ISO date. Returns null for garbage, far past, or far future dates. */
export function parseFeedDate(raw: unknown, now: Date): string | null {
  const s = cleanText(raw, 80);
  if (!s) return null;
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    // Common RSS defects: missing seconds, "UT", trailing zone names, "Sept".
    const fixed = s
      .replace(/\bSept\b/i, 'Sep')
      .replace(/\bUT\b/, 'GMT')
      .replace(/\s+\(.*\)$/, '')
      .replace(/(\d{1,2}:\d{2})(\s+[+-]\d{4}|\s+[A-Z]{2,4})?$/, (m, hm: string, z?: string) => `${hm}:00${z ?? ''}`);
    t = Date.parse(fixed);
  }
  if (Number.isNaN(t)) return null;
  const nowMs = now.getTime();
  if (t > nowMs + 15 * 60_000) return null; // future-dated items are not trusted
  if (t < Date.UTC(1995, 0, 1)) return null;
  return new Date(t).toISOString();
}

/** "1:02:03", "62:03", "3723" -> seconds. */
export function parseDuration(raw: unknown): number | undefined {
  const s = cleanText(raw, 20);
  if (!s) return undefined;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 && n < 24 * 3600 ? n : undefined;
  }
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(s);
  if (!m) return undefined;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return sec > 0 && sec < 24 * 3600 ? sec : undefined;
}
