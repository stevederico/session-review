/**
 * Browse main pane: transcript for the session selected in the sidebar.
 * Selection is driven by `?session=` (set by AppSidebar / layout HeaderSearch).
 */
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/empty';
import MessagesSquare from '@stevederico/skateboard-ui/icons/MessagesSquare';
import CircleAlert from '@stevederico/skateboard-ui/icons/CircleAlert';
import { formatCost, shortModel } from '../lib/format';
import Transcript from './Transcript';
import ResumeKey from './ResumeKey';
import {
  AUTO_DETECT,
  notifySessionsChanged,
  type Project,
  type SessionDetail,
} from '../lib/sessionTypes';

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
 * Main browse content: transcript for the session selected in the app sidebar.
 * Conversation list lives in AppSidebar; this view reads `?session=`.
 */
export default function BrowseView() {
  const [searchParams] = useSearchParams();
  const selectedSessionId = searchParams.get('session') ?? '';

  const [projects, setProjects] = useState<Project[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [status, setStatus] = useState('');

  const loadProjects = useCallback(async () => {
    try {
      const data = await apiRequest<Project[]>('/cc/projects');
      setProjects(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load projects for tagging', err);
    }
  }, []);

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
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      setDetailError('');
      return;
    }
    void loadDetail(selectedSessionId);
  }, [selectedSessionId, loadDetail]);

  /**
   * File the open conversation under a project, or clear with AUTO_DETECT.
   * Refreshes detail and notifies the sidebar to reload its list.
   *
   * @param value - Target project key, or AUTO_DETECT to clear.
   */
  const handleTagProject = async (value: string | null) => {
    if (!selectedSessionId) return;
    const project = value === AUTO_DETECT ? null : value;
    try {
      await apiRequest('/cc/tag', {
        method: 'POST',
        body: JSON.stringify({ id: selectedSessionId, project }),
      });
      await loadDetail(selectedSessionId);
      await loadProjects();
      notifySessionsChanged();
    } catch (err) {
      console.error('Failed to assign project', err);
      setStatus('Could not assign this conversation to a project.');
    }
  };

  const detailMeta = detail?.meta ?? null;
  const detailModels = (detailMeta?.models || '')
    .split(',')
    .map((m) => shortModel(m.trim()))
    .filter(Boolean);
  const projectsByName = [...projects].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {status ? (
        <p
          role="status"
          aria-live="polite"
          className="px-4 py-2 text-sm text-muted-foreground lg:px-6"
        >
          {status}
        </p>
      ) : null}

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
          <>
            <div className="flex shrink-0 flex-col gap-2 border-b border-border p-4 lg:px-6">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {detailMeta?.cwd ? (
                  <span className="truncate font-mono">{detailMeta.cwd}</span>
                ) : null}
                {detailMeta?.source ? (
                  <Badge variant="secondary">{detailMeta.source}</Badge>
                ) : null}
                {detailMeta?.git_branch ? (
                  <Badge variant="outline">{detailMeta.git_branch}</Badge>
                ) : null}
                {detailModels.map((m) => (
                  <Badge key={m} variant="secondary">
                    {m}
                  </Badge>
                ))}
                {typeof detailMeta?.msg_count === 'number' ? (
                  <Badge variant="outline">{detailMeta.msg_count} msgs</Badge>
                ) : null}
                <Badge variant="outline">{formatCost(detailMeta?.cost)}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Project</span>
                <Select
                  value={detailMeta?.project_key ?? AUTO_DETECT}
                  onValueChange={handleTagProject}
                >
                  <SelectTrigger
                    className="w-56"
                    aria-label="Assign this conversation to a project"
                    size="sm"
                  >
                    <SelectValue placeholder={detailMeta?.project_name ?? 'Auto-detect'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_DETECT}>Auto-detect (clear)</SelectItem>
                    {projectsByName.map((p) => (
                      <SelectItem key={p.project} value={p.project}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {detailMeta?.overridden ? <Badge variant="secondary">tagged</Badge> : null}
              </div>
              <ResumeKey
                id={detailMeta?.id ?? selectedSessionId}
                cwd={detailMeta?.cwd}
                source={detailMeta?.source}
              />
            </div>
            <div className="min-h-0 flex-1">
              <Transcript records={detail.records} meta={detail.meta} />
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
