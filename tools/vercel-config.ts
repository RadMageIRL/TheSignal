// Writes vercel.json for a production deploy from the built site and the public Blob store's
// base URL. Kept out of the repository (see .gitignore) so the store's address is not published:
// browsers and feed readers only ever see /signal/... on the site's own domain.
//
//   SIGNAL_PUBLIC_BLOB_BASE=https://<store>.public.blob.vercel-storage.com node tools/vercel-config.ts
//
// Run after `npm run build` (the CSP hashes the built page's inline script).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { securityHeaders } from './security-headers.ts';

export function vercelConfig(blobBase: string, indexHtml: string) {
  if (!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com$/.test(blobBase)) throw new Error(`SIGNAL_PUBLIC_BLOB_BASE must be https://<store>.public.blob.vercel-storage.com, got ${blobBase}`);
  const sec = Object.entries(securityHeaders(indexHtml)).map(([key, value]) => ({ key, value }));
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: 'vite',
    buildCommand: 'npm run build',
    outputDirectory: 'dist',
    redirects: [
      { source: '/', destination: '/signal/', permanent: false },
      { source: '/signal', destination: '/signal/', permanent: false },
    ],
    // The bare /signal/ gets its own rule: on Vercel a :path* source does not match the bare path
    // (seen on the Labs project), and radmagelabs.com/signal/ rewrites to exactly that path here.
    rewrites: [
      { source: '/signal/data/snapshot.json', destination: `${blobBase}/current/snapshot.json` },
      { source: '/signal/rss.xml', destination: `${blobBase}/current/rss.xml` },
      { source: '/signal/rss/:feed([a-z]+).xml', destination: `${blobBase}/current/rss/:feed.xml` },
      { source: '/signal/', destination: '/index.html' },
      { source: '/signal/:path*', destination: '/:path*' },
    ],
    headers: [
      { source: '/(.*)', headers: sec },
      { source: '/signal/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/api/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }, { key: 'Cache-Control', value: 'no-store' }] },
    ],
    crons: [{ path: '/api/collect', schedule: '*/15 * * * *' }],
    // Budget 60 s plus the longest in-run waits (due time and Crawl-delay, 30 s each) and two request timeouts.
    functions: { 'api/collect.ts': { maxDuration: 180 } },
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const base = process.env.SIGNAL_PUBLIC_BLOB_BASE ?? '';
  const config = vercelConfig(base, readFileSync('dist/index.html', 'utf8'));
  writeFileSync('vercel.json', JSON.stringify(config, null, 2) + '\n');
  console.log('wrote vercel.json');
}
