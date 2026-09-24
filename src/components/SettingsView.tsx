import { useState } from 'react';
import ShellSettingsView from '@stevederico/skateboard-ui/SettingsView';
import { apiRequest, getCSRFToken } from '@stevederico/skateboard-ui/Utilities';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import pkg from '@package';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
} from '@stevederico/skateboard-ui/shadcn/ui/card';
import { RefreshCw } from 'lucide-react';
import { notifySessionsChanged } from '../lib/sessionTypes';

/**
 * App settings: the skateboard-ui shell settings (account, billing, theme)
 * with a "Transcripts" card appended for reindexing. Registered via
 * `overrides.settings` in {@link module:main}, replacing the shell's default
 * SettingsView while still rendering it inline so nothing is lost.
 *
 * @returns The settings view.
 */
export default function SettingsView() {
  const [isReindexing, setIsReindexing] = useState(false);
  const [status, setStatus] = useState('');

  /** Force a full backend re-scan of coding-agent sessions and report the result. */
  const handleRefresh = async () => {
    setIsReindexing(true);
    setStatus('');
    try {
      const csrfToken = getCSRFToken();
      const result = await apiRequest<{ files?: number; changed?: number }>(
        '/cc/reindex',
        {
          method: 'POST',
          headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
        },
      );
      const files = result?.files ?? 0;
      const changed = result?.changed ?? 0;
      setStatus(`Reindexed ${files} session${files === 1 ? '' : 's'}, ${changed} changed.`);
      notifySessionsChanged();
    } catch (err) {
      console.error('Reindex failed', err);
      setStatus('Reindex failed. Check that the local server is running.');
    } finally {
      setIsReindexing(false);
    }
  };

  return (
    // Plain (non-flex) scroll container so the shell view's `flex-1` root sizes
    // to its content instead of consuming the column and pinning our card to the
    // bottom. Our card then flows directly beneath it in the same scroll.
    // `[&>div:first-child>div:last-child]:hidden` suppresses the shell view's
    // own version footer so we can render it at the true bottom, below our card.
    <div className="min-h-0 flex-1 overflow-y-auto [&>div:first-child>div:last-child]:hidden">
      <ShellSettingsView />
      {/* Match the shell's centered, max-width card column. The shell's content
          column ends in p-4 bottom padding, which gives the same 1rem gap the
          shell uses between its own cards. */}
      <div className="flex flex-col items-center px-4 pb-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Transcripts</CardTitle>
            <CardDescription>
              Rescan ~/.claude and ~/.grok for new and changed agent sessions.
            </CardDescription>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isReindexing}
                aria-label="Reindex transcripts"
              >
                <RefreshCw size={18} className={cn(isReindexing && 'animate-spin')} />
                Refresh
              </Button>
            </CardAction>
          </CardHeader>
          {status ? (
            <p
              role="status"
              aria-live="polite"
              className="px-6 pb-6 text-label-sm text-muted-foreground"
            >
              {status}
            </p>
          ) : null}
        </Card>
      </div>

      {/* Version pinned to the very bottom, after our appended card. */}
      <div className="pb-24 text-center md:pb-8">
        <p className="text-xs text-muted-foreground">v{pkg.version || '0.0.0'}</p>
      </div>
    </div>
  );
}
