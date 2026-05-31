/**
 * Claude Code transcript indexer.
 *
 * Reads local JSONL session transcripts from ~/.claude/projects, builds a
 * SQLite index (sessions metadata + FTS5 full-text) for fast browse / search /
 * analytics. Indexing is incremental by file mtime. The full transcript is
 * always read fresh from the source file so rendering keeps full fidelity
 * (thinking, tool_use, tool_result, attachments).
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Strip Claude Code slash-command meta tags from a one-line session title.
 * Mirrors the frontend stripCommandTags but collapses to a single line.
 * @param {string} s
 * @returns {string}
 */
function stripCmdTags(s) {
  return String(s ?? '')
    .replace(/<((?:local-)?command-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:local-)?command-[a-z-]+\b[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const DB_DIR = join(import.meta.dirname, 'databases');
const DB_PATH = join(DB_DIR, 'ccindex.db');

/** Pricing per 1M tokens (USD). Matched by substring of the model id. */
const PRICING = {
  opus:   { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3,  out: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { in: 0.8, out: 4, cacheWrite: 1,     cacheRead: 0.08 },
};

/** Resolve the pricing table for a model id by substring match. */
export function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('haiku')) return PRICING.haiku;
  return PRICING.sonnet; // sensible default
}

/** Estimate USD cost for a token bundle under the model's pricing. */
export function costOf({ in_tok = 0, out_tok = 0, cache_create = 0, cache_read = 0, model }) {
  const p = priceFor(model);
  return (in_tok * p.in + out_tok * p.out + cache_create * p.cacheWrite + cache_read * p.cacheRead) / 1e6;
}

/**
 * Resolve a session's canonical project from its working directory.
 *
 * Collapses a repo's Claude Code git worktrees — nested at
 * `<repo>/.claude/worktrees/<slug>` — back onto the parent repo, so a repo and
 * all its worktrees aggregate as one project. Prefers the real `cwd` over the
 * dash-encoded transcript folder name, which can't be reliably decoded to a
 * path because folder names legitimately contain dashes.
 *
 * @param {string} cwd - Working directory captured from the transcript.
 * @param {string} [project] - Encoded ~/.claude/projects folder name (fallback).
 * @returns {{key: string, name: string}} Stable grouping key + display name.
 */
export function canonicalProject(cwd, project = '') {
  let path = (cwd && cwd.trim()) ? cwd.trim() : (project || '');
  // Collapse a git worktree path onto its parent repo. Current transcripts nest
  // worktrees at "<repo>/.claude/worktrees/<slug>"; the dash-encoded folder name
  // renders that same path as "...--claude-worktrees-<slug>".
  const wt = path.search(/[/\\]\.claude[/\\]worktrees[/\\]|--claude-worktrees-/);
  if (wt !== -1) path = path.slice(0, wt);
  const key = path.replace(/[/\\]+$/, '');
  const name = basename(key) || key || '(unknown)';
  return { key, name };
}

/**
 * Group session rows by canonical project, summing usage metrics.
 *
 * @param {object[]} rows - Rows carrying `cwd`, `project`, and any of
 *   `msg_count`, `tokens`, `cost`, `first_ts`, `last_ts`.
 * @returns {object[]} One aggregate per project: `{project, name, cwd,
 *   sessions, messages, tokens, cost, created, updated}` (unsorted).
 */
function groupByProject(rows) {
  const groups = new Map();
  for (const r of rows) {
    const { key, name } = canonicalProject(r.cwd, r.project);
    let g = groups.get(key);
    if (!g) {
      g = { project: key, name, cwd: key, sessions: 0, messages: 0,
            tokens: 0, cost: 0, created: '', updated: '' };
      groups.set(key, g);
    }
    g.sessions += 1;
    g.messages += r.msg_count || 0;
    g.tokens += r.tokens || 0;
    g.cost += r.cost || 0;
    if (r.first_ts && (!g.created || r.first_ts < g.created)) g.created = r.first_ts;
    if (r.last_ts && r.last_ts > g.updated) g.updated = r.last_ts;
  }
  return [...groups.values()];
}

let db;

function getDb() {
  if (db) return db;
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      file TEXT,
      project TEXT,
      cwd TEXT,
      git_branch TEXT,
      first_ts TEXT,
      last_ts TEXT,
      msg_count INTEGER,
      user_count INTEGER,
      asst_count INTEGER,
      models TEXT,
      summary TEXT,
      in_tok INTEGER,
      out_tok INTEGER,
      cache_read INTEGER,
      cache_create INTEGER,
      cost REAL,
      mtime REAL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
      session_id UNINDEXED, ts UNINDEXED, role UNINDEXED, project UNINDEXED, body
    );
  `);
  return db;
}

/** Pull plain text out of a record's content for search indexing. */
export function extractText(rec) {
  const msg = rec.message;
  const content = msg && typeof msg === 'object' ? msg.content : rec.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (!b || typeof b !== 'object') return '';
        if (b.type === 'text') return b.text || '';
        if (b.type === 'thinking') return b.thinking || '';
        if (b.type === 'tool_use') return `${b.name || ''} ${JSON.stringify(b.input || {})}`;
        if (b.type === 'tool_result') {
          const c = b.content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) return c.map((x) => (x && x.text) || '').join(' ');
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/** Parse one JSONL file into a session row + per-message fts rows. */
function parseFile(file) {
  const path = join(PROJECTS_DIR, file.project, file.name);
  let lines;
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return null;
  }
  const id = file.name.replace(/\.jsonl$/, '');
  const row = {
    id, file: path, project: file.project, cwd: '', git_branch: '',
    first_ts: '', last_ts: '', msg_count: 0, user_count: 0, asst_count: 0,
    models: new Set(), summary: '', in_tok: 0, out_tok: 0, cache_read: 0,
    cache_create: 0, cost: 0, mtime: file.mtime,
  };
  const fts = [];
  let firstUserText = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const t = rec.type;

    if (rec.cwd && !row.cwd) row.cwd = rec.cwd;
    if (rec.gitBranch && !row.git_branch) row.git_branch = rec.gitBranch;
    if (rec.timestamp) {
      if (!row.first_ts) row.first_ts = rec.timestamp;
      row.last_ts = rec.timestamp;
    }

    if (t === 'summary' && rec.summary) { row.summary = rec.summary; continue; }
    if (t !== 'user' && t !== 'assistant') continue;
    if (rec.isSidechain) { /* still index, but mark via role */ }

    row.msg_count++;
    const role = t;
    if (t === 'user') row.user_count++;
    if (t === 'assistant') {
      row.asst_count++;
      const msg = rec.message || {};
      if (msg.model) row.models.add(msg.model);
      const u = msg.usage || {};
      row.in_tok += u.input_tokens || 0;
      row.out_tok += u.output_tokens || 0;
      row.cache_read += u.cache_read_input_tokens || 0;
      row.cache_create += u.cache_creation_input_tokens || 0;
    }

    const body = extractText(rec).slice(0, 20000);
    if (t === 'user' && !firstUserText && body.trim()) firstUserText = body.trim();
    if (body.trim()) {
      fts.push({ session_id: id, ts: rec.timestamp || '', role, project: file.project, body });
    }
  }

  // cost: split tokens across models if multiple; approximate with dominant model
  const modelList = [...row.models];
  row.cost = costOf({ ...row, model: modelList[0] });
  row.models = modelList.join(',');
  if (!row.summary) row.summary = firstUserText.slice(0, 200);
  if (!row.cwd) row.cwd = file.project;
  return { row, fts };
}

/** List candidate transcript files with mtimes. */
function listFiles() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out = [];
  for (const project of readdirSync(PROJECTS_DIR)) {
    const pdir = join(PROJECTS_DIR, project);
    let st;
    try { st = statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(pdir)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const fst = statSync(join(pdir, name));
        out.push({ project, name, mtime: fst.mtimeMs });
      } catch { /* skip */ }
    }
  }
  return out;
}

let lastIndex = 0;

/** Incrementally (re)index changed files. Cheap to call repeatedly. */
export function reindex(force = false) {
  const d = getDb();
  const files = listFiles();
  const known = new Map(
    d.prepare('SELECT id, mtime FROM sessions').all().map((r) => [r.id, r.mtime])
  );
  const seen = new Set();
  const insSession = d.prepare(`
    INSERT OR REPLACE INTO sessions
    (id,file,project,cwd,git_branch,first_ts,last_ts,msg_count,user_count,asst_count,models,summary,in_tok,out_tok,cache_read,cache_create,cost,mtime)
    VALUES (@id,@file,@project,@cwd,@git_branch,@first_ts,@last_ts,@msg_count,@user_count,@asst_count,@models,@summary,@in_tok,@out_tok,@cache_read,@cache_create,@cost,@mtime)
  `);
  const delFts = d.prepare('DELETE FROM msg_fts WHERE session_id = ?');
  const insFts = d.prepare('INSERT INTO msg_fts (session_id,ts,role,project,body) VALUES (?,?,?,?,?)');

  let changed = 0;
  for (const f of files) {
    const id = f.name.replace(/\.jsonl$/, '');
    seen.add(id);
    if (!force && known.has(id) && known.get(id) === f.mtime) continue;
    const parsed = parseFile(f);
    if (!parsed) continue;
    insSession.run(parsed.row);
    delFts.run(id);
    for (const m of parsed.fts) insFts.run(m.session_id, m.ts, m.role, m.project, m.body);
    changed++;
  }
  // prune deleted files
  for (const id of known.keys()) {
    if (!seen.has(id)) {
      d.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      delFts.run(id);
    }
  }
  lastIndex = changed;
  return { files: files.length, changed };
}

/**
 * List projects with aggregate session counts, messages, cost, and recency.
 *
 * Sessions are grouped by their canonical project (see {@link canonicalProject}),
 * so a repo's git worktrees fold into the parent repo. One row per project,
 * most-recently-active first.
 *
 * @returns {{project: string, name: string, cwd: string, sessions: number,
 *   messages: number, last_ts: string, cost: number}[]}
 */
export function projects() {
  const d = getDb();
  reindex();
  const rows = d.prepare(
    'SELECT cwd, project, msg_count, first_ts, last_ts, cost FROM sessions'
  ).all();
  return groupByProject(rows)
    .map((g) => ({
      project: g.project, name: g.name, cwd: g.cwd,
      sessions: g.sessions, messages: g.messages,
      last_ts: g.updated, cost: g.cost,
    }))
    .sort((a, b) => (b.last_ts || '').localeCompare(a.last_ts || ''));
}

/**
 * List sessions, optionally filtered to one canonical project.
 *
 * The `project` argument is a canonical project key (as returned by
 * {@link projects}); matching folds a repo's git worktrees into the parent
 * repo. Command-tag noise is stripped from each summary.
 *
 * @param {string} [project] - Canonical project key, or falsy for all sessions.
 * @returns {object[]} Session rows, most-recent first.
 */
export function sessions(project) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, id AS sessionId, project, cwd, git_branch, first_ts, last_ts,
           msg_count, user_count, asst_count, models, summary,
           in_tok, out_tok, cache_read, cache_create, cost
    FROM sessions
    ORDER BY last_ts DESC
  `).all();
  const filtered = project
    ? rows.filter((r) => canonicalProject(r.cwd, r.project).key === project)
    : rows;
  return filtered.map((r) => ({ ...r, summary: stripCmdTags(r.summary) }));
}

/** Full transcript read fresh from the source file. */
export function session(id) {
  const d = getDb();
  const meta = d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!meta) return null;
  meta.summary = stripCmdTags(meta.summary);
  let records = [];
  try {
    records = readFileSync(meta.file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { /* file gone */ }
  return { meta, records };
}

export function search(q, project, limit = 100) {
  if (!q || !q.trim()) return [];
  const d = getDb();
  reindex();
  // sanitize for FTS5: quote each term to avoid syntax errors
  const match = q.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
  // When filtering by a canonical project we post-filter in JS (worktrees fold
  // into their parent), so the SQL LIMIT is dropped and applied after filtering.
  const sql = `
    SELECT f.session_id AS id, f.project, f.ts, f.role,
           snippet(msg_fts, 4, '[', ']', ' … ', 12) AS snippet,
           s.summary, s.cwd
    FROM msg_fts f JOIN sessions s ON s.id = f.session_id
    WHERE msg_fts MATCH ?
    ORDER BY f.ts DESC ${project ? '' : 'LIMIT ?'}`;
  try {
    let rows = project ? d.prepare(sql).all(match) : d.prepare(sql).all(match, limit);
    if (project) {
      rows = rows
        .filter((r) => canonicalProject(r.cwd, r.project).key === project)
        .slice(0, limit);
    }
    return rows.map((r) => ({ ...r, name: basename(r.cwd || r.project), summary: stripCmdTags(r.summary) }));
  } catch {
    return [];
  }
}

/**
 * Aggregate usage stats across all indexed sessions.
 *
 * Reindexes first, then returns totals plus breakdowns by project (canonical —
 * git worktrees fold into their parent repo, see {@link canonicalProject}), by
 * model, and by day (all days with activity). `byProject` and `byDay` rows each include
 * summed `tokens` (in + out + cache read/write), `messages`, `sessions`, and
 * `cost`; `byProject` rows also carry `created` (earliest `first_ts`) and
 * `updated` (latest `last_ts`) ISO timestamps for sorting.
 *
 * @returns {{totals: object, byProject: object[], byModel: object[], byDay: object[]}}
 */
export function stats() {
  const d = getDb();
  reindex();
  const totals = d.prepare(`
    SELECT COUNT(*) AS sessions, SUM(msg_count) AS messages,
           SUM(in_tok+out_tok+cache_read+cache_create) AS tokens, SUM(cost) AS cost
    FROM sessions`).get();
  const byProject = groupByProject(d.prepare(`
    SELECT cwd, project, msg_count,
           in_tok+out_tok+cache_read+cache_create AS tokens,
           cost, first_ts, last_ts
    FROM sessions`).all())
    .sort((a, b) => b.cost - a.cost);
  const byModel = d.prepare(`
    SELECT models, COUNT(*) AS sessions, SUM(out_tok) AS out_tok, SUM(cost) AS cost
    FROM sessions WHERE models <> '' GROUP BY models ORDER BY cost DESC`).all();
  const byDay = d.prepare(`
    SELECT substr(last_ts,1,10) AS day, COUNT(*) AS sessions,
           SUM(msg_count) AS messages,
           SUM(in_tok+out_tok+cache_read+cache_create) AS tokens,
           SUM(cost) AS cost
    FROM sessions WHERE last_ts <> '' GROUP BY day ORDER BY day DESC`).all();
  return { totals, byProject, byModel, byDay };
}
