/**
 * Modal with metadata for the open conversation (cwd, source, branch, model,
 * cost, project tag, resume command) — content formerly in the Browse header.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import { formatCost, shortModel } from '../lib/format';
import ResumeKey from './ResumeKey';
import {
  AUTO_DETECT,
  notifySessionsChanged,
  type Project,
  type SessionDetail,
  type SessionMetaData,
} from '../lib/sessionTypes';

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
 * Fetch and display session metadata in a dialog. Project tagging from here
 * notifies the sidebar to refresh.
 */
export default function SessionInfoDialog({
  open,
  onOpenChange,
  sessionId,
}: SessionInfoDialogProps) {
  const [meta, setMeta] = useState<SessionMetaData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError('');
    setStatus('');
    try {
      const [detail, projectRows] = await Promise.all([
        apiRequest<SessionDetail>(`/cc/session/${encodeURIComponent(id)}`),
        apiRequest<Project[]>('/cc/projects'),
      ]);
      setMeta(detail?.meta ?? null);
      setProjects(Array.isArray(projectRows) ? projectRows : []);
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
      setStatus('');
      return;
    }
    void load(sessionId);
  }, [open, sessionId, load]);

  /**
   * Assign or clear the session's project override.
   *
   * @param value - Target project key, or AUTO_DETECT to clear.
   */
  const handleTagProject = async (value: string | null) => {
    if (!sessionId) return;
    const project = value === AUTO_DETECT ? null : value;
    try {
      await apiRequest('/cc/tag', {
        method: 'POST',
        body: JSON.stringify({ id: sessionId, project }),
      });
      await load(sessionId);
      notifySessionsChanged();
    } catch (err) {
      console.error('Failed to assign project', err);
      setStatus('Could not assign this conversation to a project.');
    }
  };

  const models = (meta?.models || '')
    .split(',')
    .map((m) => shortModel(m.trim()))
    .filter(Boolean);
  const projectsByName = useMemo(() => {
    const rows = projects.slice();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [projects]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-full max-w-[calc(100%-2rem)] overflow-hidden sm:max-w-lg"
        showCloseButton
      >
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>Conversation info</DialogTitle>
          <DialogDescription>
            Working directory, model, cost, project assignment, and resume command.
          </DialogDescription>
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

            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
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
            </div>

            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <span className="shrink-0 text-xs text-muted-foreground">Project</span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Select
                  value={meta.project_key ?? AUTO_DETECT}
                  onValueChange={handleTagProject}
                >
                  <SelectTrigger
                    className="w-full min-w-0 max-w-full sm:max-w-xs"
                    aria-label="Assign this conversation to a project"
                    size="sm"
                  >
                    <SelectValue placeholder={meta.project_name ?? 'Auto-detect'} />
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
                {meta.overridden ? <Badge variant="secondary">tagged</Badge> : null}
              </div>
            </div>

            <div className="min-w-0 max-w-full overflow-hidden">
              <ResumeKey
                id={meta.id ?? sessionId}
                cwd={meta.cwd}
                source={meta.source}
                className="max-w-full"
              />
            </div>

            {status ? (
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {status}
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
