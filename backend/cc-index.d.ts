/**
 * Type declarations for the app-custom Claude Code transcript indexer
 * (`cc-index.js`). The runtime module is JSDoc-annotated JavaScript; this
 * sidecar gives its consumers (server.ts) a precise, `any`-free surface.
 * Dynamic SQLite result rows are typed as `Record<string, unknown>` since
 * callers only JSON-serialize them.
 */

/** Pricing per 1M tokens (USD) for a model family. */
export interface Pricing {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
}

/** A canonical project identity derived from a session's working directory. */
export interface ProjectRef {
  key: string;
  name: string;
}

/** Minimal session shape needed to resolve a project. */
export interface SessionLike {
  id: string;
  cwd?: string;
  project?: string;
}

/** Aggregate result of a reindex pass. */
export interface ReindexResult {
  files: number;
  changed: number;
}

/** Result of setting/clearing a manual session→project override. */
export interface OverrideResult {
  id: string;
  project_key: string | null;
}

/** Full session detail: metadata row plus raw transcript records. */
export interface SessionDetail {
  meta: Record<string, unknown>;
  records: Record<string, unknown>[];
}

/** Aggregated usage statistics. */
export interface Stats {
  totals: Record<string, unknown>;
  byProject: Record<string, unknown>[];
  byModel: Record<string, unknown>[];
  byDay: Record<string, unknown>[];
}

export function priceFor(model: string): Pricing;

export function costOf(bundle: {
  in_tok?: number;
  out_tok?: number;
  cache_create?: number;
  cache_read?: number;
  model?: string;
}): number;

export function canonicalProject(cwd: string, project?: string): ProjectRef;

export function resolveProject(row: SessionLike, overrides?: Map<string, string>): ProjectRef;

export function extractText(rec: Record<string, unknown>): string;

export function isConversational(rec: Record<string, unknown>): boolean;

export function reindex(force?: boolean): ReindexResult;

export function projects(): Record<string, unknown>[];

export function setOverride(id: string, projectKey: string | null): OverrideResult;

export function listOverrides(): Record<string, unknown>[];

export function sessions(project?: string): Record<string, unknown>[];

export function session(id: string): SessionDetail | null;

export function search(q: string, project?: string, limit?: number): Record<string, unknown>[];

export function stats(): Stats;
