import { describe, expect, it } from 'vitest';
import { etagOf, isNotModified, rssBuildDate } from '../../tools/http-cache.ts';

const built = new Date('2026-11-22T12:00:00Z');

describe('HTTP validators for feeds', () => {
  it('gives identical bytes the same strong ETag and different bytes a different one', () => {
    expect(etagOf('<rss/>')).toBe(etagOf('<rss/>'));
    expect(etagOf('<rss/>')).not.toBe(etagOf('<rss />'));
    expect(etagOf('<rss/>')).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('reads Last-Modified from the feed build date', () => {
    expect(rssBuildDate('<lastBuildDate>Sun, 22 Nov 2026 12:00:00 GMT</lastBuildDate>')!.toISOString()).toBe(built.toISOString());
    expect(rssBuildDate('<rss/>')).toBeNull();
  });

  it('answers 304 for a matching If-None-Match, including a weak or listed one', () => {
    const e = etagOf('x');
    expect(isNotModified({ 'if-none-match': e }, e, built)).toBe(true);
    expect(isNotModified({ 'if-none-match': `"other", W/${e}` }, e, built)).toBe(true);
    expect(isNotModified({ 'if-none-match': '*' }, e, built)).toBe(true);
  });

  it('lets If-None-Match win over If-Modified-Since, as RFC 9110 requires', () => {
    const e = etagOf('x');
    expect(isNotModified({ 'if-none-match': '"stale"', 'if-modified-since': built.toUTCString() }, e, built)).toBe(false);
  });

  it('answers 304 for If-Modified-Since at or after the build time and 200 before it', () => {
    const e = etagOf('x');
    expect(isNotModified({ 'if-modified-since': built.toUTCString() }, e, built)).toBe(true);
    expect(isNotModified({ 'if-modified-since': new Date(built.getTime() - 1000).toUTCString() }, e, built)).toBe(false);
    expect(isNotModified({ 'if-modified-since': 'garbage' }, e, built)).toBe(false);
    expect(isNotModified({}, e, built)).toBe(false);
  });
});
