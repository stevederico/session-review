import { useState, useEffect, useCallback } from 'react';
import Header from '@stevederico/skateboard-ui/Header';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
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
import RefreshCw from '@stevederico/skateboard-ui/icons/RefreshCw';
import MessagesSquare from '@stevederico/skateboard-ui/icons/MessagesSquare';
import FolderOpen from '@stevederico/skateboard-ui/icons/FolderOpen';
import CircleAlert from '@stevederico/skateboard-ui/icons/CircleAlert';
import { formatCost, relativeTime, shortModel, folderName } from '../lib/format.js';
import Transcript from './Transcript.jsx';

/** Sentinel value for the "All projects" Select option (no project filter). */
const ALL_PROJECTS = '__all__';

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
 * @param {Object} props
 * @param {string} props.message - Human-readable error description.
 * @param {Function} props.onRetry - Refetch handler bound to a "Try again" button.
 * @returns {JSX.Element}
 */
function ErrorState({ message, onRetry }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><CircleAlert size={24} /></EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <Button onClick={onRetry}>Try again</Button>
    </Empty>
  );
}

/**
 * Render one muted metadata line for a session row.
 *
 * @param {Object} props
 * @param {Object} props.session - Session row from /cc/sessions.
 * @returns {JSX.Element}
 */
function SessionMeta({ session }) {
  const models = (session.models || '')
    .split(',')
    .map((m) => shortModel(m.trim()))
    .filter(Boolean)
    .join(', ');
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      <span>{relativeTime(session.last_ts)}</span>
      <span aria-hidden="true">·</span>
      <span>{session.msg_count} msgs</span>
      {models ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="truncate">{models}</span>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <span>{formatCost(session.cost)}</span>
    </span>
  );
}

/**
 * Master/detail browse experience: pick a project, scan its sessions, and
 * read the selected conversation transcript. This is the app's "home" route.
 *
 * Owns three independent fetch lifecycles (projects, sessions, session
 * detail), each with its own loading / error / empty handling.
 *
 * @returns {JSX.Element}
 */
export default function BrowseView() {
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');

  // Default to "All projects" so the Select is controlled with a defined value
  // from the first render (passing undefined makes Base UI treat it as
  // uncontrolled, then switching to a real value warns/breaks).
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState('');

  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [isReindexing, setIsReindexing] = useState(false);
  const [status, setStatus] = useState('');

  /** Fetch all projects; default the picker to "All projects". */
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError('');
    try {
      const data = await apiRequest('/cc/projects');
      const list = Array.isArray(data) ? data : [];
      setProjects(list);
      setSelectedProject((prev) => prev || ALL_PROJECTS);
    } catch (err) {
      console.error('Failed to load projects', err);
      setProjectsError('Could not load projects. Check that the local server is running.');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  /**
   * Fetch the session list for a project key (or all sessions when ALL_PROJECTS).
   *
   * @param {string} project - Project key, or ALL_PROJECTS for no filter.
   */
  const loadSessions = useCallback(async (project) => {
    if (!project) return;
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const endpoint = project === ALL_PROJECTS
        ? '/cc/sessions'
        : `/cc/sessions?project=${encodeURIComponent(project)}`;
      const data = await apiRequest(endpoint);
      setSessions(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load sessions', err);
      setSessionsError('Could not load conversations for this project.');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  /**
   * Fetch a single session's metadata and raw records for the transcript pane.
   *
   * @param {string} id - Session id.
   */
  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    setDetailLoading(true);
    setDetailError('');
    try {
      const data = await apiRequest(`/cc/session/${encodeURIComponent(id)}`);
      setDetail(data ?? null);
    } catch (err) {
      console.error('Failed to load session', err);
      setDetailError('Could not load this conversation.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    loadSessions(selectedProject);
  }, [selectedProject, loadSessions]);

  /** Switch the active project, clearing any open conversation. */
  const handleSelectProject = (value) => {
    setSelectedProject(value);
    setSelectedSessionId('');
    setDetail(null);
    setDetailError('');
  };

  /** Open a conversation in the right pane and fetch its transcript. */
  const handleSelectSession = (id) => {
    setSelectedSessionId(id);
    loadDetail(id);
  };

  /** Force a backend re-scan, then reload projects and the current session list. */
  const handleRefresh = async () => {
    setIsReindexing(true);
    setStatus('');
    try {
      const result = await apiRequest('/cc/reindex', { method: 'POST' });
      const files = result?.files ?? 0;
      const changed = result?.changed ?? 0;
      setStatus(`Reindexed ${files} file${files === 1 ? '' : 's'}, ${changed} changed.`);
      await Promise.all([loadProjects(), loadSessions(selectedProject)]);
    } catch (err) {
      console.error('Reindex failed', err);
      setStatus('Reindex failed. Check that the local server is running.');
    } finally {
      setIsReindexing(false);
    }
  };

  const detailMeta = detail?.meta ?? null;
  const detailModels = (detailMeta?.models || '')
    .split(',')
    .map((m) => shortModel(m.trim()))
    .filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header title="Browse">
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
      </Header>

      {status ? (
        <p role="status" aria-live="polite" className="px-4 py-2 text-sm text-muted-foreground lg:px-6">
          {status}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* LEFT PANE: project picker + session list */}
        <aside className="flex min-h-0 shrink-0 flex-col border-b border-border md:w-80 md:border-b-0 md:border-r">
          <div className="shrink-0 p-3">
            <Select
              value={selectedProject}
              onValueChange={handleSelectProject}
              disabled={projectsLoading || !!projectsError}
            >
              <SelectTrigger className="w-full" aria-label="Filter by project">
                <SelectValue placeholder="Select a project">
                  {(value) => {
                    if (!value) return 'Select a project';
                    if (value === ALL_PROJECTS) return 'All projects';
                    const p = projects.find((proj) => proj.project === value);
                    return p ? `${p.name} (${p.sessions})` : value;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.project} value={p.project}>
                    {p.name} ({p.sessions})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {projectsLoading ? <LoadingState /> : null}

            {!projectsLoading && projectsError ? (
              <ErrorState message={projectsError} onRetry={loadProjects} />
            ) : null}

            {!projectsLoading && !projectsError && sessionsLoading ? <LoadingState /> : null}

            {!projectsLoading && !projectsError && !sessionsLoading && sessionsError ? (
              <ErrorState message={sessionsError} onRetry={() => loadSessions(selectedProject)} />
            ) : null}

            {!projectsLoading && !projectsError && !sessionsLoading && !sessionsError && sessions.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FolderOpen size={24} /></EmptyMedia>
                  <EmptyTitle>No conversations</EmptyTitle>
                  <EmptyDescription>Nothing recorded for this project yet.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            {!projectsLoading && !projectsError && !sessionsLoading && !sessionsError && sessions.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {sessions.map((session) => {
                  const isSelected = session.id === selectedSessionId;
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        onClick={() => handleSelectSession(session.id)}
                        aria-current={isSelected ? 'true' : undefined}
                        className={cn(
                          'flex w-full flex-col gap-1 rounded-md p-3 text-left outline-none transition-colors',
                          'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                          isSelected && 'bg-accent',
                        )}
                      >
                        <span className="truncate text-sm font-medium text-foreground">
                          <span className="text-muted-foreground">{folderName(session)}</span>{' '}{session.summary || '(no summary)'}
                        </span>
                        <SessionMeta session={session} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </aside>

        {/* RIGHT PANE: selected conversation transcript */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {!selectedSessionId ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><MessagesSquare size={24} /></EmptyMedia>
                <EmptyTitle>Select a conversation</EmptyTitle>
                <EmptyDescription>Pick a session from the list to read its transcript.</EmptyDescription>
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
                <h2 className="text-pretty text-base font-medium text-foreground">
                  {detailMeta?.summary || '(no summary)'}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {detailMeta?.cwd ? <span className="truncate font-mono">{detailMeta.cwd}</span> : null}
                  {detailMeta?.git_branch ? <Badge variant="outline">{detailMeta.git_branch}</Badge> : null}
                  {detailModels.map((m) => (
                    <Badge key={m} variant="secondary">{m}</Badge>
                  ))}
                  {typeof detailMeta?.msg_count === 'number' ? (
                    <Badge variant="outline">{detailMeta.msg_count} msgs</Badge>
                  ) : null}
                  <Badge variant="outline">{formatCost(detailMeta?.cost)}</Badge>
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <Transcript records={detail.records} meta={detail.meta} />
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
