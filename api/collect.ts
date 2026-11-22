// Vercel Cron calls this every 15 minutes (vercel.json). Vercel sends CRON_SECRET as a bearer
// token; anything else is refused before any work. The answer is a short status only; details
// go to the private operations log.
import { timingSafeEqual } from 'node:crypto';
import type { SourceEntry } from '../shared/types.ts';
import registry from '../registry/sources.json' with { type: 'json' };
import { productionRun } from '../ingest/production.ts';

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request.headers.get('authorization'), process.env.CRON_SECRET)) return json({ error: 'unauthorized' }, 401);
  const r = await productionRun(process.env, registry as SourceEntry[]);
  return json({ status: r.status, published: r.published });
}
