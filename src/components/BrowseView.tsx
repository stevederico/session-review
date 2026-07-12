import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Separator } from '@stevederico/skateboard-ui/shadcn/ui/separator';
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
import FolderOpen from '@stevederico/skateboard-ui/icons/FolderOpen';
import CircleAlert from '@stevederico/skateboard-ui/icons/CircleAlert';
import { formatCost, formatTokens, relativeTime, shortModel, folderName } from '../lib/format';
import Transcript from './Transcript';
import HeaderSearch from './HeaderSearch';
import ResumeKey from './ResumeKey';

/** A project row from `/cc/projects`. */
interface Project {
  project: string;
  name: string;
  sessions: number;
  tokens: number;
  cost: number;
  messages: number;
  last_ts: string;
  created: string;
}

/** A session row from `/cc/sessions`. */
interface Session {
  id: string;
  summary?: string;
  cwd?: string;
  project?: string;
  msg_count: number;
  cost: number;
  in_tok: number;
  out_tok: number;
  cache_read: number;
  cache_create: number;
  first_ts: string;
  last_ts: string;
}

/** Session metadata from `/cc/session/:id` (the `meta` field). */
interface SessionMetaData {
  id?: string;
  cwd?: string;
  git_branch?: string;
  models?: string;
  msg_count?: number;
  cost?: number;
  project_key?: string;
  project_name?: string;
  overridden?: boolean;
}

/** Full `/cc/session/:id` response: metadata plus raw transcript records. */
interface SessionDetail {
  meta?: SessionMetaData;
  /** Raw Claude Code JSONL records, passed straight to {@link Transcript}. */
  records: unknown[];
}

/** Sentinel value for the "All projects" Select option (no project filter). */
const ALL_PROJECTS = '__all__';

/** Sentinel for the tag control's "Auto-detect" option (clears any override). */
const AUTO_DETECT = '__auto__';

/** Total tokens for a session: input + output + cache read + cache create. */
const tokensOf = (s: Session): number =>
  (Number(s.in_tok) || 0) + (Number(s.out_tok) || 0) +
  (Number(s.cache_read) || 0) + (Number(s.cache_create) || 0);

/** One option in the session/project sort control. */
interface SessionSortOption {
  value: string;
  label: string;
  /** Read the numeric sort key from a session row. */
  get: (s: Session) => number;
  /** Read the numeric sort key from a project row. */
  getProject: (p: Project) => number;
}

/**
 * Sort options that drive both the project picker and the session list. `get`
 * reads the numeric key from a session row, `getProject` from a project row;
 * both sort descending. Mirrors the analytics project sorts, minus "Sessions"
 * (each session row is a single session).
 */
const SESSION_SORTS: SessionSortOption[] = [
  { value: 'recent', label: 'Last updated', get: (s) => Date.parse(s.last_ts) || 0, getProject: (p) => Date.parse(p.last_ts) || 0 },
  { value: 'created', label: 'Date created', get: (s) => Date.parse(s.first_ts) || 0, getProject: (p) => Date.parse(p.created) || 0 },
  { value: 'cost', label: 'Cost', get: (s) => Number(s.cost) || 0, getProject: (p) => Number(p.cost) || 0 },
  { value: 'tokens', label: 'Tokens', get: (s) => tokensOf(s), getProject: (p) => Number(p.tokens) || 0 },
  { value: 'messages', label: 'Messages', get: (s) => Number(s.msg_count) || 0, getProject: (p) => Number(p.messages) || 0 },
];

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
 * @param props.session - Session row from /cc/sessions.
 */
function SessionMeta({ session }: { session: Session }) {
  return (
    <span className="flex w-full items-center justify-between text-xs text-muted-foreground">
      <span>{session.msg_count} msgs</span>
      <span>{formatTokens(tokensOf(session))} tok</span>
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
 */
export default function BrowseView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');

  // Default to "All projects" so the Select is controlled with a defined value
  // from the first render (passing undefined makes Base UI treat it as
  // uncontrolled, then switching to a real value warns/breaks).
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState('');
  const [sessionSort, setSessionSort] = useState('recent');

  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [status, setStatus] = useState('');

  /** Fetch all projects; default the picker to "All projects". */
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError('');
    try {
      const data = await apiRequest<Project[]>('/cc/projects');
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
   * @param project - Project key, or ALL_PROJECTS for no filter.
   */
  const loadSessions = useCallback(async (project: string) => {
    if (!project) return;
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const endpoint = project === ALL_PROJECTS
        ? '/cc/sessions'
        : `/cc/sessions?project=${encodeURIComponent(project)}`;
      const data = await apiRequest<Session[]>(endpoint);
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
  const handleSelectProject = (value: string | null) => {
    setSelectedProject(value ?? ALL_PROJECTS);
    setSelectedSessionId('');
    setDetail(null);
    setDetailError('');
  };

  /** Open a conversation in the right pane and fetch its transcript. */
  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
    loadDetail(id);
  };

  /**
   * File the open conversation under a project, or clear its assignment with
   * AUTO_DETECT. Refreshes projects, the session list, and the open detail so
   * the move is reflected everywhere.
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
      await Promise.all([
        loadProjects(),
        loadSessions(selectedProject),
        loadDetail(selectedSessionId),
      ]);
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

  // Sort both the project picker and the loaded session list client-side
  // (descending) by the active key.
  const activeSessionSort = SESSION_SORTS.find((s) => s.value === sessionSort) ?? SESSION_SORTS[0];
  const sortedProjects = [...projects].sort(
    (a, b) => activeSessionSort.getProject(b) - activeSessionSort.getProject(a),
  );
  const sortedSessions = [...sessions].sort(
    (a, b) => activeSessionSort.get(b) - activeSessionSort.get(a),
  );
  // Alphabetical project list for the tag control (easier to scan than by metric).
  const projectsByName = [...projects].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar: global conversation search replaces the page title; results
          open in the right transcript pane via handleSelectSession. */}
      <header className="flex h-(--header-height) shrink-0 items-center gap-2">
        <div className="flex w-full items-center gap-2 px-4 lg:px-6">
          <HeaderSearch onSelect={handleSelectSession} className="w-full max-w-xl" />
        </div>
      </header>
      <Separator />

      {status ? (
        <p role="status" aria-live="polite" className="px-4 py-2 text-sm text-muted-foreground lg:px-6">
          {status}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* LEFT PANE: project picker + session list */}
        <aside className="flex min-h-0 shrink-0 flex-col border-b border-border md:w-80 md:border-b-0 md:border-r">
          <div className="flex shrink-0 flex-col gap-2 p-3">
            <Select
              value={selectedProject}
              onValueChange={handleSelectProject}
            >
              <SelectTrigger
                className="w-full"
                aria-label="Filter by project"
                disabled={projectsLoading || !!projectsError}
              >
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {sortedProjects.map((p) => (
                  <SelectItem key={p.project} value={p.project}>
                    {p.name} ({p.sessions})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sessionSort} onValueChange={(value) => setSessionSort(value ?? 'recent')}>
              <SelectTrigger className="w-full" aria-label="Sort projects and conversations by" size="sm">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                {SESSION_SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
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
                {sortedSessions.map((session) => {
                  const isSelected = session.id === selectedSessionId;
                  return (
                    <li key={session.id} className="group/session relative">
                      <button
                        type="button"
                        onClick={() => handleSelectSession(session.id)}
                        aria-current={isSelected ? 'true' : undefined}
                        className={cn(
                          'flex w-full flex-col gap-2 rounded-md px-4 py-4 text-left outline-none transition-colors',
                          'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                          isSelected && 'bg-accent',
                        )}
                      >
                        <span className="flex w-full items-center justify-between gap-x-2 text-xs text-muted-foreground">
                          <span className="truncate font-semibold">{folderName(session)}</span>
                          <span className="shrink-0">{relativeTime(session.last_ts)}</span>
                        </span>
                        <span className="w-full truncate text-xs text-foreground">
                          {session.summary || '(no summary)'}
                        </span>
                        <SessionMeta session={session} />
                      </button>
                      {/* Copy `claude --resume <id>` without opening the row; revealed
                          on hover/focus so it doesn't clutter the dense list. */}
                      <ResumeKey
                        id={session.id}
                        cwd={session.cwd}
                        variant="compact"
                        className="absolute right-2 top-3 rounded bg-accent opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100"
                      />
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
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Project</span>
                  <Select
                    value={detailMeta?.project_key ?? AUTO_DETECT}
                    onValueChange={handleTagProject}
                  >
                    <SelectTrigger className="w-56" aria-label="Assign this conversation to a project" size="sm">
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
                {/* Resume key — the exact command to reopen this conversation in
                    the terminal (`claude --resume <id>`). */}
                <ResumeKey id={detailMeta?.id ?? selectedSessionId} cwd={detailMeta?.cwd} />
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
