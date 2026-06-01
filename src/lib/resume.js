/**
 * Single-quote a string for safe interpolation into a POSIX shell command.
 * Wraps in single quotes and escapes any embedded single quote as `'\''`.
 *
 * @param {string} s - Raw value (e.g. a filesystem path).
 * @returns {string} Shell-safe single-quoted token.
 */
function shellQuote(s) {
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
 * @param {string} id - Session id (transcript UUID).
 * @param {string} [cwd] - Conversation's working directory; prefixes a `cd`.
 * @returns {string} e.g. `cd '/repo' && claude --resume 1234-…`; empty string
 *   for a falsy id.
 */
export function resumeCommand(id, cwd) {
  if (!id) return '';
  const base = `claude --resume ${id}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${base}` : base;
}
