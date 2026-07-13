/**
 * Single-quote a string for safe interpolation into a POSIX shell command.
 * Wraps in single quotes and escapes any embedded single quote as `'\''`.
 *
 * @param s - Raw value (e.g. a filesystem path).
 * @returns Shell-safe single-quoted token.
 */
function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Supported coding-agent sources that can be resumed from a session id. */
export type SessionSource = 'claude' | 'grok' | string;

/**
 * Build the shell command that resumes a local agent session by its id.
 *
 * Claude Code: `claude --resume <id>`
 * Grok CLI:    `grok --resume <id>`
 *
 * When a `cwd` is given, the command is prefixed with `cd <cwd> &&` so it
 * resumes in the conversation's own project directory.
 *
 * @param id - Session id (transcript UUID).
 * @param cwd - Conversation's working directory; prefixes a `cd` when present.
 * @param source - Agent that produced the session (`claude` | `grok`).
 * @returns e.g. `cd '/repo' && grok --resume 1234-…`; empty string for a falsy id.
 */
export function resumeCommand(
  id: string | null | undefined,
  cwd?: string | null,
  source: SessionSource = 'claude',
): string {
  if (!id) return '';
  const bin = source === 'grok' ? 'grok' : 'claude';
  const base = `${bin} --resume ${id}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${base}` : base;
}
