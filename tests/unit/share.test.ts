import { describe, expect, it } from 'vitest';
import { SHARE_URL, SUPPORT_URL, shareMessage, shareSignal } from '../../src/lib/share.ts';

describe('sharing The Signal', () => {
  it('shares the canonical address and the Labs support page is the established one', () => {
    expect(SHARE_URL).toBe('https://radmagelabs.com/signal/');
    expect(SUPPORT_URL).toBe('https://buymeacoffee.com/radmageirl');
  });

  it('uses the share sheet when the browser has one', async () => {
    const shared: ShareData[] = [];
    const r = await shareSignal({ share: async (d) => { shared.push(d); }, canShare: () => true });
    expect(r).toBe('shared');
    expect(shared).toEqual([{ title: 'The Signal | Global headlines, many perspectives', url: 'https://radmagelabs.com/signal/' }]);
    expect(shareMessage(r)).toBe('');
  });

  it('copies the address when there is no share sheet, or when the browser cannot share it', async () => {
    const copied: string[] = [];
    const clipboard = { writeText: async (t: string) => { copied.push(t); } };
    expect(await shareSignal({ clipboard })).toBe('copied');
    expect(await shareSignal({ share: async () => {}, canShare: () => false, clipboard })).toBe('copied');
    expect(copied).toEqual([SHARE_URL, SHARE_URL]);
    expect(shareMessage('copied')).toBe('Link copied: https://radmagelabs.com/signal/');
  });

  it('copies the address when the share sheet fails for a reason other than the reader closing it', async () => {
    const copied: string[] = [];
    const r = await shareSignal({ share: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }, clipboard: { writeText: async (t) => { copied.push(t); } } });
    expect(r).toBe('copied');
    expect(copied).toEqual([SHARE_URL]);
  });

  it('stops when the reader closes the share sheet, copying nothing', async () => {
    const copied: string[] = [];
    const r = await shareSignal({ share: async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); }, clipboard: { writeText: async (t) => { copied.push(t); } } });
    expect(r).toBe('cancelled');
    expect(copied).toEqual([]);
    expect(shareMessage(r)).toBe('');
  });

  it('shows the address to copy by hand when copying is refused or unavailable', async () => {
    expect(await shareSignal({ clipboard: { writeText: async () => { throw new Error('denied'); } } })).toBe('manual');
    expect(await shareSignal({})).toBe('manual');
    expect(shareMessage('manual')).toBe('Copy this link: https://radmagelabs.com/signal/');
  });
});
