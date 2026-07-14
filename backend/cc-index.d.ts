/**
 * Type declarations for the multi-source session indexer (`cc-index.js`).
 * Supports coding agents: claude (~/.claude/projects) and grok (~/.grok/sessions).
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

/** Full session detail: metadata row plus normalized transcript records. */
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

export function toIso(ts?: number | string, ms?: number): string;

export function decodeGrokCwd(encoded: string, groupDir: string): string;

export function grokToolName(u: Record<string, unknown>): string;

export function stringifyGrokOutput(u: Record<string, unknown>): string;

export function grokUpdatesToRecords(sessionDir: string): Record<string, unknown>[];

export function reindex(force?: boolean): ReindexResult;

export function projects(): Record<string, unknown>[];

export function sessions(project?: string): Record<string, unknown>[];

export function session(id: string): SessionDetail | null;

export function search(q: string, project?: string, limit?: number): Record<string, unknown>[];

export function stats(): Stats;

export const CLAUDE_DIR: string;
export const PROJECTS_DIR: string;
export const GROK_SESSIONS: string;
export const GROK_HOME: string;
