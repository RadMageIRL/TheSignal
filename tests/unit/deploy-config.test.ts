import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inlineScriptHashes, securityHeaders } from '../../tools/security-headers.ts';
import { vercelConfig } from '../../tools/vercel-config.ts';

const INDEX = readFileSync('index.html', 'utf8');
const BASE = 'https://abc123def.public.blob.vercel-storage.com';

describe('security headers', () => {
  it('allows the page inline theme script by its hash and nothing inline otherwise', () => {
    const body = /<script>([\s\S]*?)<\/script>/.exec(INDEX)![1]!;
    const expected = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    expect(inlineScriptHashes(INDEX)).toEqual([expected]);
    const csp = securityHeaders(INDEX)['Content-Security-Policy']!;
    expect(csp).toContain(`script-src 'self' ${expected}`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('ignores scripts loaded by src when hashing', () => {
    expect(inlineScriptHashes('<script type="module" src="/signal/assets/x.js"></script>')).toEqual([]);
  });
});

describe('the generated vercel.json', () => {
  const cfg = vercelConfig(BASE, INDEX);

  it('serves the snapshot and feeds from the public store under the site paths, and everything else from the build', () => {
    expect(cfg.rewrites).toEqual([
      { source: '/signal/data/snapshot.json', destination: `${BASE}/current/snapshot.json` },
      { source: '/signal/rss.xml', destination: `${BASE}/current/rss.xml` },
      { source: '/signal/rss/:feed([a-z]+).xml', destination: `${BASE}/current/rss/:feed.xml` },
      { source: '/signal/:path*', destination: '/:path*' },
    ]);
  });

  it('runs the collector every 15 minutes with a bounded duration', () => {
    expect(cfg.crons).toEqual([{ path: '/api/collect', schedule: '*/15 * * * *' }]);
    expect(cfg.functions['api/collect.ts'].maxDuration).toBeLessThanOrEqual(180);
  });

  it('sends the security headers on every path and keeps the collector out of search engines and caches', () => {
    const all = cfg.headers.find((h) => h.source === '/(.*)')!.headers.map((h) => h.key);
    expect(all).toEqual(expect.arrayContaining(['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']));
    const api = cfg.headers.find((h) => h.source === '/api/(.*)')!.headers;
    expect(api).toEqual(expect.arrayContaining([{ key: 'X-Robots-Tag', value: 'noindex' }, { key: 'Cache-Control', value: 'no-store' }]));
  });

  it('refuses anything but a public Vercel Blob store as the data origin', () => {
    for (const bad of ['', 'http://abc.public.blob.vercel-storage.com', 'https://evil.example', 'https://abc.private.blob.vercel-storage.com']) {
      expect(() => vercelConfig(bad, INDEX), bad).toThrow(/SIGNAL_PUBLIC_BLOB_BASE/);
    }
  });
});
