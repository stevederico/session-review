/**
 * Browse main pane: transcript for the session selected in the sidebar.
 * Selection is driven by `?session=` (set by AppSidebar / layout HeaderSearch).
 * Session metadata lives in SessionInfoDialog (info button on the search bar).
 */
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/empty';
import MessagesSquare from '@stevederico/skateboard-ui/icons/MessagesSquare';
import CircleAlert from '@stevederico/skateboard-ui/icons/CircleAlert';
import Transcript from './Transcript';
import type { SessionDetail } from '../lib/sessionTypes';

/** Render a centered loading Spinner that fills its parent. */
function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Spinner />
    </div>
  );
}

/**
 * Render an error Empty state with a retry action.
 *
 * @param props.message - Human-readable error description.
 * @param props.onRetry - Refetch handler bound to a "Try again" button.
 */
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CircleAlert size={24} />
        </EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <Button onClick={onRetry}>Try again</Button>
    </Empty>
  );
}

/**
 * Main browse content: transcript only for the session selected in the sidebar.
 */
export default function BrowseView() {
  const [searchParams] = useSearchParams();
  const selectedSessionId = searchParams.get('session') ?? '';

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  /**
   * Fetch a single session's metadata and raw records for the transcript pane.
   *
   * @param id - Session id.
   */
  const loadDetail = useCallback(async (id: string) => {
    if (!id) return;
    setDetailLoading(true);
    setDetailError('');
    try {
      const data = await apiRequest<SessionDetail>(`/cc/session/${encodeURIComponent(id)}`);
      setDetail(data ?? null);
    } catch (err) {
      console.error('Failed to load session', err);
      setDetailError('Could not load this conversation.');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      setDetailError('');
      return;
    }
    void loadDetail(selectedSessionId);
  }, [selectedSessionId, loadDetail]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {!selectedSessionId ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquare size={24} />
              </EmptyMedia>
              <EmptyTitle>Select a conversation</EmptyTitle>
              <EmptyDescription>
                Pick a session from the sidebar to read its transcript.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {selectedSessionId && detailLoading ? <LoadingState /> : null}

        {selectedSessionId && !detailLoading && detailError ? (
          <ErrorState message={detailError} onRetry={() => loadDetail(selectedSessionId)} />
        ) : null}

        {selectedSessionId && !detailLoading && !detailError && detail ? (
          <div className="min-h-0 flex-1">
            <Transcript records={detail.records} meta={detail.meta} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
