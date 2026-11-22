import { useEffect, useState } from 'react';
import { SHARE_URL, SUPPORT_URL, shareMessage, shareSignal } from '../lib/share.ts';

/**
 * Share and Buy me a coffee, in the top bar and in the footer, as in the other RadMage Labs apps.
 * Small and secondary: text links, no popups. The result of a share is announced in a status line.
 */
export function SupportLinks({ place }: { place: 'top' | 'footer' }) {
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(''), 10_000);
    return () => window.clearTimeout(t);
  }, [message]);
  return (
    <span className={`support support-${place}`}>
      <button type="button" className="text-btn support-share" title={`Share ${SHARE_URL}`}
        onClick={async () => setMessage(shareMessage(await shareSignal()))}>
        Share
      </button>
      <span className="support-sep" aria-hidden="true">&middot;</span>
      <a className="support-coffee" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
        Buy me a coffee<span className="sr-only"> (opens in a new tab)</span>
      </a>
      <span className="support-status" role="status" aria-live="polite">{message}</span>
    </span>
  );
}
