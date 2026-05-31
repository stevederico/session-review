/**
 * Small display formatters shared across views.
 */

/** Format a USD amount: `$1.2k`, `$3.40`, `$0.012`. */
export function formatCost(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v > 0) return `$${v.toFixed(3)}`;
  return '$0';
}

/** Format a token count: `1.2B`, `3.4M`, `12.0k`, `42`. */
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** Format an ISO timestamp as a short local date-time. */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/** Compact relative age, e.g. `3d`, `5h`, `now`. */
export function relativeTime(iso) {
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
export function shortModel(model) {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(',<synthetic>', '');
}
