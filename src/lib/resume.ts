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

/**
 * Build the shell command that resumes a Claude Code session by its id.
 *
 * A session's id is the transcript filename (a UUID), which is exactly what
 * `claude --resume` accepts to reopen that conversation. When a `cwd` is given,
 * the command is prefixed with `cd <cwd> &&` so it resumes in the conversation's
 * own project directory regardless of where it's pasted (`claude --resume`
 * resolves sessions relative to the working directory). Kept JSX-free so it can
 * be unit-tested with `node --test` and shared by the ResumeKey component.
 *
 * @param id - Session id (transcript UUID).
 * @param cwd - Conversation's working directory; prefixes a `cd` when present.
 * @returns e.g. `cd '/repo' && claude --resume 1234-…`; empty string
 *   for a falsy id.
 */
export function resumeCommand(id: string | null | undefined, cwd?: string | null): string {
  if (!id) return '';
  const base = `claude --resume ${id}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${base}` : base;
}
