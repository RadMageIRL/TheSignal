import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, normalize, sep } from 'node:path';
import { JSON_CONTENT_TYPE, RSS_CONTENT_TYPE, etagOf, isNotModified, rssBuildDate } from './tools/http-cache.ts';
import { securityHeaders } from './tools/security-headers.ts';

// Local review only: serve a site folder (snapshot.json, rss.xml, rss/*.xml) at /signal/.
// SIGNAL_SITE names the folder; otherwise a private capture in local/site-data/current is used
// when present, else the synthetic fixture in tests/fixtures/site. Nothing here is part of the
// build output.
function siteRoot(): string {
  if (process.env.SIGNAL_SITE) return resolve(process.env.SIGNAL_SITE);
  const local = resolve('local/site-data/current');
  return existsSync(resolve(local, 'snapshot.json')) ? local : resolve('tests/fixtures/site');
}

const ROUTES: [RegExp, (m: RegExpExecArray) => string, string][] = [
  [/^\/signal\/data\/snapshot\.json$/, () => 'snapshot.json', JSON_CONTENT_TYPE],
  [/^\/signal\/rss\.xml$/, () => 'rss.xml', RSS_CONTENT_TYPE],
  [/^\/signal\/rss\/([a-z]+)\.xml$/, (m) => `rss/${m[1]}.xml`, RSS_CONTENT_TYPE],
];

function localSite(): Plugin {
  const handler = (
    req: { url?: string; headers: Record<string, string | string[] | undefined> },
    res: { setHeader: (k: string, v: string) => void; end: (b?: string) => void; statusCode: number },
    next: () => void,
  ) => {
    const path = (req.url ?? '').split('?')[0]!;
    for (const [re, file, type] of ROUTES) {
      const m = re.exec(path);
      if (!m) continue;
      const root = siteRoot();
      const full = normalize(resolve(root, file(m)));
      if (!full.startsWith(root + sep) || !existsSync(full)) { res.statusCode = 404; return res.end('not found'); }
      const body = readFileSync(full, 'utf8');
      const etag = etagOf(body);
      const built = type === RSS_CONTENT_TYPE ? rssBuildDate(body) : null;
      res.setHeader('content-type', type);
      res.setHeader('etag', etag);
      if (built) res.setHeader('last-modified', built.toUTCString());
      res.setHeader('cache-control', type === RSS_CONTENT_TYPE ? 'public, max-age=900' : 'no-cache');
      if (isNotModified(req.headers, etag, built)) { res.statusCode = 304; return res.end(); }
      return res.end(body);
    }
    next();
  };
  return {
    name: 'local-site',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

// Ship the third-party licence notices next to the built site.
function notices(): Plugin {
  return {
    name: 'third-party-notices',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8') });
    },
  };
}

// The public site lives under https://radmagelabs.com/signal/, so every asset path is built
// relative to /signal/.
export default defineConfig({
  base: '/signal/',
  plugins: [react(), localSite(), notices()],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: { host: '127.0.0.1', port: 4390, strictPort: true },
  // The preview serves the built site under the production security headers, so the browser tests
  // exercise the real Content-Security-Policy.
  preview: { headers: existsSync('dist/index.html') ? securityHeaders(readFileSync('dist/index.html', 'utf8')) : {} },
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
