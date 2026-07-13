/**
 * Small display formatters shared across views.
 */

/** A number, or anything coercible to one (display formatters call `Number()`). */
type Numeric = number | string | null | undefined;

/** Format a USD amount: `$1.2k`, `$3.40`, `$0.012`. */
export function formatCost(n: Numeric): string {
  const v = Number(n) || 0;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v > 0) return `$${v.toFixed(3)}`;
  return '$0';
}

/** Format a token count: `1.2B`, `3.4M`, `12.0k`, `42`. */
export function formatTokens(n: Numeric): string {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** Format an ISO timestamp as a short local date-time. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Compact month/day label for a `YYYY-MM-DD` day key, e.g. `5/31`.
 * Parses the date parts directly so the label never shifts across timezones.
 *
 * @param {string} day - A day key in `YYYY-MM-DD` form.
 * @returns {string} The `M/D` label, or `''` if the input is unparseable.
 */
export function formatDayShort(day: string | null | undefined): string {
  if (!day) return '';
  const [, month, date] = day.split('-').map(Number);
  if (!month || !date) return '';
  return `${month}/${date}`;
}

/** Compact relative age, e.g. `3d`, `5h`, `now`. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d`;
  return `${Math.floor(secs / 2592000)}mo`;
}

/** Shorten a model id for display: `claude-opus-4-8` → `opus-4-8`. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(',<synthetic>', '');
}

/**
 * Working-folder name for a session, e.g. `session-review`.
 *
 * Prefers the real `cwd` basename — it preserves dashes in the folder name,
 * which the dash-encoded `project` key cannot distinguish from path
 * separators. Falls back to the project key, then a placeholder.
 *
 * @param session - Session row carrying a working directory and/or project key.
 * @returns The folder name, or `(unknown)` when neither is present.
 */
export function folderName(session: { cwd?: string; project?: string } | null | undefined): string {
  const raw = session?.cwd || session?.project || '';
  const base = String(raw).replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop();
  return base || '(unknown)';
}
