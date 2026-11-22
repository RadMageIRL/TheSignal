// Sharing The Signal, as the other RadMage Labs apps do: the browser's own share sheet where it
// has one, otherwise the address is copied, and if even that is not allowed the address is shown
// to copy by hand. Always the canonical address, never a reader's search or preferences. No
// third-party code and nothing sent anywhere: the browser does all of it.
import { IDENTITY } from '../../shared/identity.ts';

export const SHARE_URL = IDENTITY.website;
export const SHARE_TITLE = 'The Signal | Global headlines, many perspectives';
/** The RadMage Labs support page, the same one every Labs app links to. */
export const SUPPORT_URL = 'https://buymeacoffee.com/radmageirl';

export type ShareResult = 'shared' | 'cancelled' | 'copied' | 'manual';

type ShareNavigator = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: { writeText: (text: string) => Promise<void> };
};

export async function shareSignal(nav: ShareNavigator = navigator): Promise<ShareResult> {
  const data: ShareData = { title: SHARE_TITLE, url: SHARE_URL };
  if (typeof nav.share === 'function' && (typeof nav.canShare !== 'function' || nav.canShare(data))) {
    try {
      await nav.share(data);
      return 'shared';
    } catch (e) {
      // The reader closed the share sheet: nothing more to do. Any other failure falls back to copying.
      if ((e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await nav.clipboard!.writeText(SHARE_URL);
    return 'copied';
  } catch {
    return 'manual';
  }
}

/** What the page says after a share attempt (nothing when the share sheet handled it). */
export function shareMessage(r: ShareResult): string {
  if (r === 'copied') return `Link copied: ${SHARE_URL}`;
  if (r === 'manual') return `Copy this link: ${SHARE_URL}`;
  return '';
}
