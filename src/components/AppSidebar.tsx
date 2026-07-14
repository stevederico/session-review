/**
 * App sidebar: logo-area Browse/Analytics picker + conversation list (Browse mode).
 */
import { memo, useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import type { ComponentProps } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import DynamicIcon from '@stevederico/skateboard-ui/DynamicIcon';
import { getState } from '@stevederico/skateboard-ui/Context';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@stevederico/skateboard-ui/shadcn/ui/sidebar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/empty';
import Settings from '@stevederico/skateboard-ui/icons/Settings';
import ChevronDown from '@stevederico/skateboard-ui/icons/ChevronDown';
import Check from '@stevederico/skateboard-ui/icons/Check';
import FolderOpen from '@stevederico/skateboard-ui/icons/FolderOpen';
import CircleAlert from '@stevederico/skateboard-ui/icons/CircleAlert';
import { relativeTime, folderName } from '../lib/format';
import {
  ALL_PROJECTS,
  APP_MODES,
  SESSION_SORTS,
  SESSIONS_CHANGED_EVENT,
  type AppModeValue,
  type Project,
  type Session,
} from '../lib/sessionTypes';

/** Props forwarded to the shadcn Sidebar root. */
type AppSidebarProps = Omit<ComponentProps<typeof SidebarRoot>, 'collapsible'>;

const modePickerItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/** Props for a single sidebar conversation row. */
interface SessionRowProps {
  session: Session;
  isSelected: boolean;
  showProject: boolean;
  onSelect: (id: string) => void;
}

/**
 * One conversation row in the sidebar list.
 * Memoized + content-visibility so long lists paint cheaper (Vercel:
 * rerender-memo, rendering-content-visibility).
 */
const SessionRow = memo(function SessionRow({
  session,
  isSelected,
  showProject,
  onSelect,
}: SessionRowProps) {
  const title = (session.summary || '').trim() || 'Untitled conversation';
  const projectLabel = showProject ? folderName(session) : '';
  const timeLabel = relativeTime(session.last_ts);
  const meta = [projectLabel, timeLabel].filter(Boolean).join(' · ');

  return (
    <li className="[content-visibility:auto] [contain-intrinsic-size:auto_3rem]">
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={isSelected ? 'true' : undefined}
        aria-label={`${title}${meta ? `, ${meta}` : ''}${isSelected ? ', selected' : ''}`}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none transition-colors',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50',
          // Solid secondary surface — clear vs idle, not inverted black.
          isSelected
            ? 'bg-surface-tertiary text-foreground hover:bg-surface-tertiary'
            : 'text-foreground hover:bg-accent',
        )}
      >
        <span
          className={cn(
            'w-full truncate text-sm',
            isSelected ? 'font-medium' : null,
          )}
        >
          {title}
        </span>
        {meta ? (
          <span className="w-full truncate text-xs text-muted-foreground">{meta}</span>
        ) : null}
      </button>
    </li>
  );
});

/**
 * Desktop sidebar: mode picker (Browse / Analytics) where the logo sits,
 * conversation list under Browse, Settings in the footer.
 */
export default function AppSidebar({ variant = 'inset', ...props }: AppSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { state } = getState();
  const constants = state.constants;

  const currentPage = (location.pathname.split('/')[2] || 'home').toLowerCase();
  const activeMode: AppModeValue =
    currentPage === 'analytics' ? 'analytics' : 'home';
  const activeModeMeta = APP_MODES.find((m) => m.value === activeMode) ?? APP_MODES[0];
  const selectedSessionId = searchParams.get('session') ?? '';

  const [modeOpen, setModeOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState('');
  const [sessionSort, setSessionSort] = useState('recent');

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError('');
    try {
      const data = await apiRequest<Project[]>('/cc/projects');
      setProjects(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load projects', err);
      setProjectsError('Could not load projects.');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async (project: string) => {
    if (!project) return;
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const endpoint =
        project === ALL_PROJECTS
          ? '/cc/sessions'
          : `/cc/sessions?project=${encodeURIComponent(project)}`;
      const data = await apiRequest<Session[]>(endpoint);
      setSessions(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load sessions', err);
      setSessionsError('Could not load conversations.');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  // Independent loads start together (async-parallel) — one effect keeps deps honest.
  useEffect(() => {
    if (activeMode !== 'home') return;
    void loadProjects();
    void loadSessions(selectedProject);
  }, [activeMode, selectedProject, loadProjects, loadSessions]);

  useEffect(() => {
    const onChanged = () => {
      if (activeMode !== 'home') return;
      // Parallel refresh of both lists after a tag/reindex (async-parallel).
      void Promise.all([loadProjects(), loadSessions(selectedProject)]);
    };
    window.addEventListener(SESSIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, onChanged);
  }, [activeMode, selectedProject, loadProjects, loadSessions]);

  /** Switch Browse ↔ Analytics via the logo picker. */
  const handleSelectMode = (value: AppModeValue) => {
    setModeOpen(false);
    const mode = APP_MODES.find((m) => m.value === value);
    if (!mode) return;
    if (value === 'home' && selectedSessionId) {
      navigate(`/app/home?session=${encodeURIComponent(selectedSessionId)}`);
    } else {
      navigate(mode.path);
    }
  };

  /** Open a conversation in Browse — leaves Settings/Analytics if needed. */
  const handleSelectSession = useCallback(
    (id: string) => {
      // Always go to /app/home so Settings (and Analytics) close and the
      // transcript pane mounts with this session selected.
      startTransition(() => {
        navigate(`/app/home?session=${encodeURIComponent(id)}`);
      });
    },
    [navigate],
  );

  const handleSelectProject = (value: string | null) => {
    const nextProject = value ?? ALL_PROJECTS;
    startTransition(() => {
      setSelectedProject(nextProject);
    });
    // Clear open conversation when the filter changes so the list doesn't lie.
    if (selectedSessionId) {
      const next = new URLSearchParams(searchParams);
      next.delete('session');
      setSearchParams(next, { replace: true });
    }
  };

  const activeSessionSort =
    SESSION_SORTS.find((s) => s.value === sessionSort) ?? SESSION_SORTS[0];
  // Memoize sorts so typing/route noise doesn't re-sort ~800 sessions every render.
  const sortedProjects = useMemo(() => {
    const rows = projects.slice();
    rows.sort(
      (a, b) => activeSessionSort.getProject(b) - activeSessionSort.getProject(a),
    );
    return rows;
  }, [projects, activeSessionSort]);
  const sortedSessions = useMemo(() => {
    const rows = sessions.slice();
    rows.sort((a, b) => activeSessionSort.get(b) - activeSessionSort.get(a));
    return rows;
  }, [sessions, activeSessionSort]);
  const showProjectOnRows = selectedProject === ALL_PROJECTS;

  return (
    <SidebarRoot collapsible="icon" variant={variant} {...props}>
      {!constants.hideSidebarHeader ? (
        <SidebarHeader className="p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <Popover open={modeOpen} onOpenChange={setModeOpen}>
                <PopoverTrigger
                  render={
                    <SidebarMenuButton
                      size="sm"
                      tooltip={activeModeMeta.label}
                      className="hover:bg-transparent active:bg-transparent"
                      aria-label={`Current view: ${activeModeMeta.label}. Change view`}
                      aria-haspopup="listbox"
                      aria-expanded={modeOpen}
                    >
                      <div className="bg-app -ml-2 flex size-8 shrink-0 items-center justify-center rounded-lg">
                        <DynamicIcon
                          name={activeModeMeta.icon}
                          strokeWidth={2}
                          className="text-background"
                        />
                      </div>
                      <span className="min-w-0 shrink truncate text-lg font-semibold">
                        {activeModeMeta.label}
                      </span>
                      <ChevronDown
                        className="ml-auto size-4 shrink-0 opacity-60 group-data-[collapsible=icon]:hidden"
                        aria-hidden
                      />
                    </SidebarMenuButton>
                  }
                />
                <PopoverContent align="start" className="w-56 gap-0 p-1" role="listbox">
                  {APP_MODES.map((mode) => {
                    const isSelected = mode.value === activeMode;
                    return (
                      <button
                        key={mode.value}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={modePickerItemClass}
                        onClick={() => handleSelectMode(mode.value)}
                      >
                        <DynamicIcon name={mode.icon} size={16} strokeWidth={2} />
                        <span className="min-w-0 flex-1 truncate text-left">{mode.label}</span>
                        {isSelected ? (
                          <Check className="size-4 shrink-0 opacity-70" aria-hidden />
                        ) : null}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
      ) : null}

      <SidebarContent>
        {activeMode === 'home' ? (
          <SidebarGroup className="flex min-h-0 flex-1 flex-col p-0">
            <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2 group-data-[collapsible=icon]:hidden">
                {projectsLoading || sessionsLoading ? (
                  <div className="flex justify-center p-6">
                    <Spinner />
                  </div>
                ) : null}

                {!projectsLoading && projectsError ? (
                  <div className="flex flex-col items-center gap-2 p-3 text-center">
                    <CircleAlert size={20} className="text-muted-foreground" aria-hidden />
                    <p className="text-xs text-muted-foreground">{projectsError}</p>
                    <Button type="button" size="sm" variant="outline" onClick={loadProjects}>
                      Try again
                    </Button>
                  </div>
                ) : null}

                {!projectsLoading &&
                !projectsError &&
                !sessionsLoading &&
                sessionsError ? (
                  <div className="flex flex-col items-center gap-2 p-3 text-center">
                    <CircleAlert size={20} className="text-muted-foreground" aria-hidden />
                    <p className="text-xs text-muted-foreground">{sessionsError}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => loadSessions(selectedProject)}
                    >
                      Try again
                    </Button>
                  </div>
                ) : null}

                {!projectsLoading &&
                !projectsError &&
                !sessionsLoading &&
                !sessionsError &&
                sessions.length === 0 ? (
                  <Empty className="border-0 p-4">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <FolderOpen size={20} />
                      </EmptyMedia>
                      <EmptyTitle className="text-sm">No conversations</EmptyTitle>
                      <EmptyDescription className="text-xs">
                        Nothing for this filter yet.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}

                {!projectsLoading &&
                !projectsError &&
                !sessionsLoading &&
                !sessionsError &&
                sessions.length > 0 ? (
                  <ul className="flex flex-col gap-0.5">
                    {sortedSessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        isSelected={session.id === selectedSessionId}
                        showProject={showProjectOnRows}
                        onSelect={handleSelectSession}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter className="gap-2">
        {activeMode === 'home' ? (
          <div className="flex flex-col gap-2 group-data-[collapsible=icon]:hidden">
            <Select value={selectedProject} onValueChange={handleSelectProject}>
              <SelectTrigger
                className="w-full"
                aria-label="Filter by project"
                size="sm"
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

            <Select
              value={sessionSort}
              onValueChange={(value) => {
                startTransition(() => setSessionSort(value ?? 'recent'));
              }}
            >
              <SelectTrigger className="w-full" aria-label="Sort conversations by" size="sm">
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
        ) : null}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={location.pathname.toLowerCase().includes('settings')}
              tooltip="Settings"
              size="sm"
              className="data-active:font-normal"
              onClick={() => navigate('/app/settings')}
            >
              <Settings size={20} strokeWidth={2} />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </SidebarRoot>
  );
}
