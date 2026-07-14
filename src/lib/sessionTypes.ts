/**
 * Shared session/project types and helpers for Browse + AppSidebar.
 */

/** A project row from `/cc/projects`. */
export interface Project {
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
export interface Session {
  id: string;
  source?: string;
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
export interface SessionMetaData {
  id?: string;
  source?: string;
  cwd?: string;
  git_branch?: string;
  models?: string;
  msg_count?: number;
  cost?: number;
  project_key?: string;
  project_name?: string;
  overridden?: boolean;
}

/** Full `/cc/session/:id` response: metadata plus normalized transcript records. */
export interface SessionDetail {
  meta?: SessionMetaData;
  /** Normalized transcript records, passed straight to Transcript. */
  records: unknown[];
}

/** Sentinel value for the "All projects" Select option (no project filter). */
export const ALL_PROJECTS = '__all__';

/** Window event name: sidebar should refetch the session list. */
export const SESSIONS_CHANGED_EVENT = 'sr:sessions-changed';

/** Notify listeners (AppSidebar) that the session list may be stale (e.g. after reindex). */
export function notifySessionsChanged(): void {
  window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT));
}

/** Total tokens for a session: input + output + cache read + cache create. */
export function tokensOf(s: Session): number {
  return (
    (Number(s.in_tok) || 0) +
    (Number(s.out_tok) || 0) +
    (Number(s.cache_read) || 0) +
    (Number(s.cache_create) || 0)
  );
}

/** One option in the session/project sort control. */
export interface SessionSortOption {
  value: string;
  label: string;
  /** Read the numeric sort key from a session row. */
  get: (s: Session) => number;
  /** Read the numeric sort key from a project row. */
  getProject: (p: Project) => number;
}

/**
 * Sort options for the project picker and session list (descending).
 */
export const SESSION_SORTS: SessionSortOption[] = [
  {
    value: 'recent',
    label: 'Last updated',
    get: (s) => Date.parse(s.last_ts) || 0,
    getProject: (p) => Date.parse(p.last_ts) || 0,
  },
  {
    value: 'created',
    label: 'Date created',
    get: (s) => Date.parse(s.first_ts) || 0,
    getProject: (p) => Date.parse(p.created) || 0,
  },
  {
    value: 'cost',
    label: 'Cost',
    get: (s) => Number(s.cost) || 0,
    getProject: (p) => Number(p.cost) || 0,
  },
  {
    value: 'tokens',
    label: 'Tokens',
    get: (s) => tokensOf(s),
    getProject: (p) => Number(p.tokens) || 0,
  },
  {
    value: 'messages',
    label: 'Messages',
    get: (s) => Number(s.msg_count) || 0,
    getProject: (p) => Number(p.messages) || 0,
  },
];

/** App shell modes available in the sidebar logo picker. */
export const APP_MODES = [
  { value: 'home', label: 'Browse', icon: 'messages-square', path: '/app/home' },
  { value: 'analytics', label: 'Analytics', icon: 'chart-bar', path: '/app/analytics' },
] as const;

export type AppModeValue = (typeof APP_MODES)[number]['value'];
