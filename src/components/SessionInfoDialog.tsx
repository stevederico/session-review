/**
 * Modal with metadata for the open conversation (cwd, source, branch, model,
 * cost, resume command).
 */
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import { formatCost, shortModel } from '../lib/format';
import ResumeKey from './ResumeKey';
import type { SessionDetail, SessionMetaData } from '../lib/sessionTypes';

/** Props for {@link SessionInfoDialog}. */
interface SessionInfoDialogProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Open-state change handler. */
  onOpenChange: (open: boolean) => void;
  /** Active session id from the URL, or empty when none selected. */
  sessionId: string;
}

/**
 * Fetch and display session metadata in a dialog.
 */
export default function SessionInfoDialog({
  open,
  onOpenChange,
  sessionId,
}: SessionInfoDialogProps) {
  const [meta, setMeta] = useState<SessionMetaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const detail = await apiRequest<SessionDetail>(
        `/cc/session/${encodeURIComponent(id)}`,
      );
      setMeta(detail?.meta ?? null);
    } catch (err) {
      console.error('Failed to load session info', err);
      setError('Could not load conversation details.');
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !sessionId) {
      setMeta(null);
      setError('');
      return;
    }
    void load(sessionId);
  }, [open, sessionId, load]);

  const models = (meta?.models || '')
    .split(',')
    .map((m) => shortModel(m.trim()))
    .filter(Boolean);

  const pills =
    meta && !loading && !error ? (
      <>
        {meta.source ? <Badge variant="secondary">{meta.source}</Badge> : null}
        {meta.git_branch ? <Badge variant="outline">{meta.git_branch}</Badge> : null}
        {models.map((m) => (
          <Badge key={m} variant="secondary">
            {m}
          </Badge>
        ))}
        {typeof meta.msg_count === 'number' ? (
          <Badge variant="outline">{meta.msg_count} msgs</Badge>
        ) : null}
        <Badge variant="outline">{formatCost(meta.cost)}</Badge>
      </>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-full max-w-[calc(100%-2rem)] overflow-hidden sm:max-w-lg"
        showCloseButton
      >
        <DialogHeader className="min-w-0 space-y-0 pr-8">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <DialogTitle className="shrink-0">Conversation info</DialogTitle>
            {pills ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                {pills}
              </div>
            ) : null}
          </div>
        </DialogHeader>

        {!sessionId ? (
          <p className="text-sm text-muted-foreground">
            Select a conversation from the sidebar first.
          </p>
        ) : null}

        {sessionId && loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : null}

        {sessionId && !loading && error ? (
          <div className="flex min-w-0 flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => load(sessionId)}>
              Try again
            </Button>
          </div>
        ) : null}

        {sessionId && !loading && !error && meta ? (
          <div className="flex min-w-0 flex-col gap-4 overflow-hidden">
            {meta.cwd ? (
              <p className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                {meta.cwd}
              </p>
            ) : null}

            <div className="min-w-0 max-w-full">
              <ResumeKey
                id={meta.id ?? sessionId}
                cwd={meta.cwd}
                source={meta.source}
                className="max-w-full"
              />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
