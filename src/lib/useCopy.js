/**
 * Shared clipboard-copy hook for transcript UI.
 *
 * Imports only React hooks (no JSX), so it keeps a plain `.js` extension and can
 * be shared by both the JSX-free markdown renderer (`markdownRender.js`) and the
 * Transcript components, replacing two duplicated implementations.
 */

import { useEffect, useRef, useState } from 'react';

/** Milliseconds the "copied" confirmation stays visible after a copy. */
export const COPY_RESET_MS = 2000;

/**
 * Copy text to the clipboard, flashing a `copied` flag for `COPY_RESET_MS`. The
 * reset timer is held in a ref and cleared on unmount and before each re-flash.
 * Clipboard failures are caught and logged (never thrown) so a copy error can
 * never crash the surrounding UI.
 *
 * @returns {{ copied: boolean, copy: (text?: string) => Promise<void> }}
 *   `copied` is true during the confirmation window; `copy(text)` writes
 *   `text ?? ''` to the clipboard.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  // Clear any pending reset timer when the component unmounts.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text ?? '');
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  return { copied, copy };
}
