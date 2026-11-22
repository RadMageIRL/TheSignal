// robots.txt evaluation per RFC 9309: pick the group for our product token (else "*"),
// then the longest matching rule wins, and Allow wins a tie. "*" matches any run of
// characters and a trailing "$" anchors the end.

export interface RobotsRule { allow: boolean; pattern: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[]; crawlDelay?: number }

export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (val) current.rules.push({ allow: key === 'allow', pattern: val });
      else if (key === 'disallow') current.rules.push({ allow: true, pattern: '' }); // "Disallow:" = allow all
    } else if (key === 'crawl-delay') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return groups;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, (c) => String.fromCharCode(92) + c))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export interface RobotsVerdict { allowed: boolean; matched?: RobotsRule; crawlDelay?: number }

export function robotsAllows(groups: RobotsGroup[], productToken: string, pathAndQuery: string): RobotsVerdict {
  const token = productToken.toLowerCase();
  let group = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  group ??= groups.find((g) => g.agents.includes('*'));
  if (!group) return { allowed: true };
  let best: RobotsRule | undefined;
  for (const r of group.rules) {
    if (r.pattern === '') continue;
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return { allowed: best ? best.allow : true, matched: best, crawlDelay: group.crawlDelay };
}
