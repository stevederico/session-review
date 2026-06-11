/**
 * Shared clipboard-copy hook for transcript UI.
 *
 * Imports only React hooks (no JSX), so it can be shared by both the JSX-free
 * markdown renderer (`markdownRender`) and the Transcript components, replacing
 * two duplicated implementations.
 */

import { useEffect, useRef, useState } from 'react';

/** Hook result: a `copied` confirmation flag and a `copy` action. */
interface UseCopyResult {
  /** True during the confirmation window after a successful copy. */
  copied: boolean;
  /** Write `text ?? ''` to the clipboard and flash `copied`. */
  copy: (text?: string) => Promise<void>;
}

/** Milliseconds the "copied" confirmation stays visible after a copy. */
export const COPY_RESET_MS = 2000;

/**
 * Copy text to the clipboard, flashing a `copied` flag for `COPY_RESET_MS`. The
 * reset timer is held in a ref and cleared on unmount and before each re-flash.
 * Clipboard failures are caught and logged (never thrown) so a copy error can
 * never crash the surrounding UI.
 *
 * @returns `copied` is true during the confirmation window; `copy(text)` writes
 *   `text ?? ''` to the clipboard.
 */
export function useCopy(): UseCopyResult {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear any pending reset timer when the component unmounts.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (text?: string): Promise<void> => {
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
