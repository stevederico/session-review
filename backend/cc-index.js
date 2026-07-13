/**
 * Local coding-agent session indexer.
 *
 * Indexes transcripts from coding agents — claude (`~/.claude/projects/*.jsonl`)
 * and grok (`~/.grok/sessions/<cwd>/<id>/`) — into SQLite (metadata + FTS5).
 * Indexing is incremental by mtime. Full transcripts are read fresh on demand
 * and normalized to a shared record shape so the UI can render both sources.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
/** @deprecated Use CLAUDE_DIR — kept for any external references. */
const PROJECTS_DIR = CLAUDE_DIR;
const GROK_HOME = process.env.GROK_HOME || join(homedir(), '.grok');
const GROK_SESSIONS = join(GROK_HOME, 'sessions');

/**
 * Strip slash-command meta tags from a one-line session title.
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
  // yagni: public list-price placeholders for grok family; refine if billing matters
  grok:   { in: 3,  out: 15, cacheWrite: 0.75,  cacheRead: 0.75 },
};

/** Resolve the pricing table for a model id by substring match. */
export function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('haiku')) return PRICING.haiku;
  if (m.includes('grok')) return PRICING.grok;
  return PRICING.sonnet;
}

/** Estimate USD cost for a token bundle under the model's pricing. */
export function costOf({ in_tok = 0, out_tok = 0, cache_create = 0, cache_read = 0, model }) {
  const p = priceFor(model);
  return (in_tok * p.in + out_tok * p.out + cache_create * p.cacheWrite + cache_read * p.cacheRead) / 1e6;
}

/**
 * Resolve a session's canonical project from its working directory.
 *
 * Collapses agent git worktrees nested at `<repo>/.claude/worktrees/<slug>`
 * (and the dash-encoded form) back onto the parent repo.
 *
 * @param {string} cwd
 * @param {string} [project]
 * @returns {{key: string, name: string}}
 */
export function canonicalProject(cwd, project = '') {
  let path = (cwd && cwd.trim()) ? cwd.trim() : (project || '');
  const wt = path.search(/[/\\]\.claude[/\\]worktrees[/\\]|--claude-worktrees-/);
  if (wt !== -1) path = path.slice(0, wt);
  const key = path.replace(/[/\\]+$/, '');
  const name = basename(key) || key || '(unknown)';
  return { key, name };
}

/**
 * Resolve a session's effective project, honoring manual overrides.
 * @param {{id: string, cwd?: string, project?: string}} row
 * @param {Map<string,string>} [overrides]
 * @returns {{key: string, name: string}}
 */
export function resolveProject(row, overrides) {
  const ov = overrides?.get(row.id);
  if (ov) return { key: ov, name: basename(ov) || ov };
  return canonicalProject(row.cwd, row.project);
}

/** Load all manual session→project assignments as an id → key Map. */
function loadOverrides(d) {
  const map = new Map();
  for (const r of d.prepare('SELECT id, project_key FROM session_overrides').all()) {
    map.set(r.id, r.project_key);
  }
  return map;
}

/**
 * Group session rows by resolved project, summing usage metrics.
 * @param {object[]} rows
 * @param {Map<string,string>} [overrides]
 * @returns {object[]}
 */
function groupByProject(rows, overrides) {
  const groups = new Map();
  for (const r of rows) {
    const { key, name } = resolveProject(r, overrides);
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
    CREATE TABLE IF NOT EXISTS session_overrides (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL
    );
  `);
  // Migrate: source column (claude | grok). Default existing rows to claude.
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('source')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude'`);
  }
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

/**
 * True if a transcript record is a real conversational message.
 * @param {object} rec
 * @returns {boolean}
 */
export function isConversational(rec) {
  const msg = rec?.message;
  const content = msg && typeof msg === 'object' ? msg.content : rec?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (b) => b && typeof b === 'object' && b.type === 'text' && (b.text || '').trim().length > 0
    );
  }
  return false;
}

/** Convert unix sec/ms or ISO string to ISO timestamp. */
export function toIso(ts, ms) {
  if (typeof ms === 'number' && Number.isFinite(ms)) return new Date(ms).toISOString();
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
  }
  if (typeof ts === 'string' && ts.trim()) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return ts;
  }
  return '';
}

/** Decode a Grok sessions group folder name to a cwd path. */
export function decodeGrokCwd(encoded, groupDir) {
  const cwdFile = join(groupDir, '.cwd');
  if (existsSync(cwdFile)) {
    try {
      const v = readFileSync(cwdFile, 'utf8').trim();
      if (v) return v;
    } catch { /* fall through */ }
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** Best-effort tool name from a Grok tool_call / tool_call_update. */
export function grokToolName(u) {
  const variant = u?.rawInput?.variant || u?.rawOutput?.variant;
  if (typeof variant === 'string' && variant.trim()) return variant.trim();
  const title = typeof u?.title === 'string' ? u.title : '';
  if (title) {
    // "Edit `/tmp/x`", "Web search:", "Write" → first token
    const cut = title.split(/[:(\[\s]/)[0].trim();
    if (cut) return cut;
  }
  if (typeof u?.kind === 'string' && u.kind) return u.kind;
  return 'tool';
}

/** Flatten Grok tool result payload for display / FTS. */
export function stringifyGrokOutput(u) {
  if (!u || typeof u !== 'object') return '';
  const raw = u.rawOutput;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const applied = raw.EditsApplied || raw.editsApplied;
    if (applied?.tool_output_for_prompt) return String(applied.tool_output_for_prompt);
    if (raw.tool_output_for_prompt) return String(raw.tool_output_for_prompt);
    if (raw.tool_output_for_prompt_concise) return String(raw.tool_output_for_prompt_concise);
    try {
      return JSON.stringify(raw, null, 2).slice(0, 20000);
    } catch {
      return '';
    }
  }
  if (Array.isArray(u.content)) {
    return u.content
      .map((c) => {
        if (!c || typeof c !== 'object') return '';
        if (c.type === 'text') return c.text || '';
        if (c.type === 'diff') {
          return [c.path, c.oldText, c.newText].filter(Boolean).join('\n');
        }
        try { return JSON.stringify(c); } catch { return ''; }
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Normalize grok `updates.jsonl` into claude-shaped records the Transcript UI
 * already understands (`type: user|assistant` + content blocks).
 *
 * @param {string} sessionDir - Path to `~/.grok/sessions/<cwd>/<id>/`.
 * @returns {object[]}
 */
export function grokUpdatesToRecords(sessionDir) {
  const updatesPath = join(sessionDir, 'updates.jsonl');
  if (!existsSync(updatesPath)) return [];
  let lines;
  try {
    lines = readFileSync(updatesPath, 'utf8').split('\n');
  } catch {
    return [];
  }

  const records = [];
  let userBuf = '';
  let userTs = '';
  let asstText = '';
  let asstThink = '';
  let asstTs = '';
  let asstModel = '';
  /** @type {Map<string, {id: string, name: string, input: object, result: string|null, isError: boolean}>} */
  const toolsById = new Map();
  /** @type {string[]} tool ids in this open assistant turn */
  let turnToolIds = [];

  const flushUser = () => {
    if (!userBuf.trim()) {
      userBuf = '';
      return;
    }
    records.push({
      type: 'user',
      timestamp: userTs || undefined,
      message: { role: 'user', content: userBuf },
    });
    userBuf = '';
  };

  const flushAsst = (usage) => {
    const hasTools = turnToolIds.length > 0;
    const hasText = asstText.trim().length > 0;
    const hasThink = asstThink.trim().length > 0;
    if (!hasTools && !hasText && !hasThink) return;

    const content = [];
    if (hasThink) content.push({ type: 'thinking', thinking: asstThink });
    if (hasText) content.push({ type: 'text', text: asstText });
    for (const tid of turnToolIds) {
      const t = toolsById.get(tid);
      if (!t) continue;
      content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
    }

    const usageBlock = usage
      ? {
          input_tokens: usage.inputTokens || 0,
          output_tokens: usage.outputTokens || 0,
          cache_read_input_tokens: usage.cachedReadTokens || 0,
          cache_creation_input_tokens: 0,
        }
      : undefined;

    records.push({
      type: 'assistant',
      timestamp: asstTs || undefined,
      message: {
        role: 'assistant',
        model: asstModel || undefined,
        content,
        usage: usageBlock,
      },
    });

    for (const tid of turnToolIds) {
      const t = toolsById.get(tid);
      if (!t || t.result == null) continue;
      records.push({
        type: 'user',
        timestamp: asstTs || undefined,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: t.id,
            content: t.result,
            is_error: Boolean(t.isError),
          }],
        },
      });
    }

    asstText = '';
    asstThink = '';
    asstTs = '';
    asstModel = '';
    turnToolIds = [];
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.params?.update;
    if (!u || typeof u !== 'object') continue;
    const t = u.sessionUpdate;
    const meta = o.params?._meta || {};
    const ts = toIso(o.timestamp, meta.agentTimestampMs);

    if (t === 'user_message_chunk') {
      flushAsst();
      const text = u.content?.text;
      if (typeof text === 'string') userBuf += text;
      if (ts) userTs = ts;
      continue;
    }

    if (t === 'agent_thought_chunk') {
      flushUser();
      const text = u.content?.text;
      if (typeof text === 'string') asstThink += text;
      if (ts) asstTs = ts;
      continue;
    }

    if (t === 'agent_message_chunk') {
      flushUser();
      const text = u.content?.text;
      if (typeof text === 'string') asstText += text;
      if (ts) asstTs = ts;
      const mid = u.content?._meta?.modelId || u._meta?.modelId;
      if (typeof mid === 'string' && mid) asstModel = mid;
      continue;
    }

    if (t === 'tool_call') {
      flushUser();
      const id = u.toolCallId || `tool-${toolsById.size}`;
      const tool = {
        id,
        name: grokToolName(u),
        input: (u.rawInput && typeof u.rawInput === 'object') ? u.rawInput : {},
        result: null,
        isError: false,
      };
      toolsById.set(id, tool);
      if (!turnToolIds.includes(id)) turnToolIds.push(id);
      if (ts) asstTs = ts;
      continue;
    }

    if (t === 'tool_call_update') {
      const id = u.toolCallId;
      if (!id) continue;
      let tool = toolsById.get(id);
      if (!tool) {
        tool = { id, name: grokToolName(u), input: {}, result: null, isError: false };
        toolsById.set(id, tool);
        if (!turnToolIds.includes(id)) turnToolIds.push(id);
      }
      if (u.rawInput && typeof u.rawInput === 'object') {
        tool.input = { ...tool.input, ...u.rawInput };
      }
      if (u.title || u.kind || u.rawInput?.variant) tool.name = grokToolName(u);
      const done = u.status === 'completed' || u.status === 'failed' || u.rawOutput != null;
      if (done) {
        tool.result = stringifyGrokOutput(u);
        tool.isError = u.status === 'failed';
      }
      if (ts) asstTs = ts;
      continue;
    }

    if (t === 'turn_completed') {
      flushUser();
      if (u.usage?.modelUsage && typeof u.usage.modelUsage === 'object') {
        const models = Object.keys(u.usage.modelUsage);
        if (models[0] && !asstModel) asstModel = models[0];
      }
      flushAsst(u.usage);
      continue;
    }
  }

  flushUser();
  flushAsst();
  return records;
}

/** Parse one claude JSONL file into a session row + FTS rows. */
function parseClaudeFile(entry) {
  const path = entry.file;
  let lines;
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return null;
  }
  const id = entry.id;
  const row = {
    id, file: path, source: 'claude', project: entry.project, cwd: '', git_branch: '',
    first_ts: '', last_ts: '', msg_count: 0, user_count: 0, asst_count: 0,
    models: new Set(), summary: '', in_tok: 0, out_tok: 0, cache_read: 0,
    cache_create: 0, cost: 0, mtime: entry.mtime,
  };
  const fts = [];
  let firstUserText = '';
  const seenUsage = new Set();
  const seenAsstMsg = new Set();

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
    const role = t;
    const msgId = rec.message?.id;

    if (t === 'assistant') {
      const msg = rec.message || {};
      if (msg.model) row.models.add(msg.model);
      if (!msgId || !seenUsage.has(msgId)) {
        if (msgId) seenUsage.add(msgId);
        const u = msg.usage || {};
        row.in_tok += u.input_tokens || 0;
        row.out_tok += u.output_tokens || 0;
        row.cache_read += u.cache_read_input_tokens || 0;
        row.cache_create += u.cache_creation_input_tokens || 0;
      }
    }

    if (isConversational(rec)) {
      if (t === 'user') {
        row.msg_count++;
        row.user_count++;
      } else if (!msgId || !seenAsstMsg.has(msgId)) {
        if (msgId) seenAsstMsg.add(msgId);
        row.msg_count++;
        row.asst_count++;
      }
    }

    const body = extractText(rec).slice(0, 20000);
    if (t === 'user' && !firstUserText && body.trim()) firstUserText = body.trim();
    if (body.trim()) {
      fts.push({ session_id: id, ts: rec.timestamp || '', role, project: entry.project, body });
    }
  }

  const modelList = [...row.models];
  row.cost = costOf({ ...row, model: modelList[0] });
  row.models = modelList.join(',');
  if (!row.summary) row.summary = firstUserText.slice(0, 200);
  if (!row.cwd) row.cwd = entry.project;
  return { row, fts };
}

/**
 * Parse a Grok session directory into a session row + FTS rows.
 * Token totals sum per-turn "new" input (input − cached) + output when usage is present.
 */
function parseGrokSession(entry) {
  const dir = entry.file;
  const summaryPath = join(dir, 'summary.json');
  let summary = {};
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch { /* optional */ }

  const id = entry.id;
  const cwd = summary?.info?.cwd || entry.cwd || '';
  const row = {
    id, file: dir, source: 'grok', project: entry.project, cwd,
    git_branch: summary.head_branch || '',
    first_ts: toIso(summary.created_at) || '',
    last_ts: toIso(summary.updated_at || summary.last_active_at) || '',
    msg_count: 0, user_count: 0, asst_count: 0,
    models: new Set(),
    summary: summary.generated_title || summary.session_summary || '',
    in_tok: 0, out_tok: 0, cache_read: 0, cache_create: 0, cost: 0,
    mtime: entry.mtime,
  };
  if (summary.current_model_id) row.models.add(summary.current_model_id);

  const fts = [];
  const updatesPath = join(dir, 'updates.jsonl');
  let userCount = 0;
  let asstCount = 0;
  let firstUserText = '';
  let userBuf = '';
  let asstBuf = '';

  if (existsSync(updatesPath)) {
    let lines;
    try {
      lines = readFileSync(updatesPath, 'utf8').split('\n');
    } catch {
      lines = [];
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const u = o?.params?.update;
      if (!u) continue;
      const t = u.sessionUpdate;
      const meta = o.params?._meta || {};
      const ts = toIso(o.timestamp, meta.agentTimestampMs);
      if (ts) {
        if (!row.first_ts) row.first_ts = ts;
        row.last_ts = ts;
      }

      if (t === 'user_message_chunk') {
        const text = u.content?.text;
        if (typeof text === 'string') userBuf += text;
      } else if (t === 'agent_message_chunk' || t === 'agent_thought_chunk') {
        const text = u.content?.text;
        if (typeof text === 'string') asstBuf += text;
        if (userBuf.trim()) {
          if (!firstUserText) firstUserText = userBuf.trim();
          fts.push({ session_id: id, ts, role: 'user', project: entry.project, body: userBuf.slice(0, 20000) });
          userCount++;
          userBuf = '';
        }
      } else if (t === 'tool_call' || t === 'tool_call_update') {
        const body = [grokToolName(u), stringifyGrokOutput(u)].filter(Boolean).join(' ').slice(0, 20000);
        if (body.trim()) {
          fts.push({ session_id: id, ts, role: 'assistant', project: entry.project, body });
        }
      } else if (t === 'turn_completed') {
        if (userBuf.trim()) {
          if (!firstUserText) firstUserText = userBuf.trim();
          fts.push({ session_id: id, ts, role: 'user', project: entry.project, body: userBuf.slice(0, 20000) });
          userCount++;
          userBuf = '';
        }
        if (asstBuf.trim()) {
          fts.push({ session_id: id, ts, role: 'assistant', project: entry.project, body: asstBuf.slice(0, 20000) });
          asstCount++;
          asstBuf = '';
        }
        const usage = u.usage;
        if (usage && typeof usage === 'object') {
          const input = usage.inputTokens || 0;
          const cached = usage.cachedReadTokens || 0;
          const out = usage.outputTokens || 0;
          // Prefer billable-ish new tokens: uncached input + output. Cache read tracked separately.
          row.in_tok += Math.max(0, input - cached);
          row.out_tok += out;
          row.cache_read += cached;
          if (usage.modelUsage && typeof usage.modelUsage === 'object') {
            for (const m of Object.keys(usage.modelUsage)) row.models.add(m);
          }
        }
      }
    }
    if (userBuf.trim()) {
      if (!firstUserText) firstUserText = userBuf.trim();
      fts.push({ session_id: id, ts: row.last_ts, role: 'user', project: entry.project, body: userBuf.slice(0, 20000) });
      userCount++;
    }
    if (asstBuf.trim()) {
      fts.push({ session_id: id, ts: row.last_ts, role: 'assistant', project: entry.project, body: asstBuf.slice(0, 20000) });
      asstCount++;
    }
  }

  row.user_count = userCount || summary.num_chat_messages || 0;
  row.asst_count = asstCount;
  row.msg_count = row.user_count + row.asst_count
    || summary.num_messages || 0;
  if (!row.summary) row.summary = firstUserText.slice(0, 200);
  const modelList = [...row.models];
  row.cost = costOf({ ...row, model: modelList[0] });
  row.models = modelList.join(',');
  if (!row.cwd) row.cwd = entry.cwd || entry.project;
  return { row, fts };
}

/** @param {{source: string, id: string, file: string, project: string, mtime: number, cwd?: string}} entry */
function parseEntry(entry) {
  return entry.source === 'grok' ? parseGrokSession(entry) : parseClaudeFile(entry);
}

/** List claude JSONL transcripts. */
function listClaudeFiles() {
  if (!existsSync(CLAUDE_DIR)) return [];
  const out = [];
  for (const project of readdirSync(CLAUDE_DIR)) {
    const pdir = join(CLAUDE_DIR, project);
    let st;
    try { st = statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(pdir)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const file = join(pdir, name);
        const fst = statSync(file);
        out.push({
          source: 'claude',
          id: name.replace(/\.jsonl$/, ''),
          file,
          project,
          mtime: fst.mtimeMs,
        });
      } catch { /* skip */ }
    }
  }
  return out;
}

/** List grok session directories under ~/.grok/sessions. */
function listGrokFiles() {
  if (!existsSync(GROK_SESSIONS)) return [];
  const out = [];
  for (const group of readdirSync(GROK_SESSIONS)) {
    // skip index db and non-dirs
    if (group.startsWith('.') || group.endsWith('.sqlite') || group.endsWith('.db')) continue;
    const gdir = join(GROK_SESSIONS, group);
    let gst;
    try { gst = statSync(gdir); } catch { continue; }
    if (!gst.isDirectory()) continue;
    const cwd = decodeGrokCwd(group, gdir);
    for (const sid of readdirSync(gdir)) {
      if (sid.startsWith('.')) continue;
      const sdir = join(gdir, sid);
      let sst;
      try { sst = statSync(sdir); } catch { continue; }
      if (!sst.isDirectory()) continue;
      // require at least summary or updates
      const updates = join(sdir, 'updates.jsonl');
      const summary = join(sdir, 'summary.json');
      if (!existsSync(updates) && !existsSync(summary)) continue;
      let mtime = sst.mtimeMs;
      try {
        if (existsSync(updates)) mtime = statSync(updates).mtimeMs;
        else if (existsSync(summary)) mtime = statSync(summary).mtimeMs;
      } catch { /* keep dir mtime */ }
      out.push({
        source: 'grok',
        id: sid,
        file: sdir,
        project: group,
        cwd,
        mtime,
      });
    }
  }
  return out;
}

/** List all candidate sessions from every supported source. */
function listFiles() {
  return [...listClaudeFiles(), ...listGrokFiles()];
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
    (id,file,project,cwd,git_branch,first_ts,last_ts,msg_count,user_count,asst_count,models,summary,in_tok,out_tok,cache_read,cache_create,cost,mtime,source)
    VALUES (@id,@file,@project,@cwd,@git_branch,@first_ts,@last_ts,@msg_count,@user_count,@asst_count,@models,@summary,@in_tok,@out_tok,@cache_read,@cache_create,@cost,@mtime,@source)
  `);
  const delFts = d.prepare('DELETE FROM msg_fts WHERE session_id = ?');
  const insFts = d.prepare('INSERT INTO msg_fts (session_id,ts,role,project,body) VALUES (?,?,?,?,?)');

  let changed = 0;
  for (const f of files) {
    const id = f.id;
    seen.add(id);
    if (!force && known.has(id) && known.get(id) === f.mtime) continue;
    const parsed = parseEntry(f);
    if (!parsed) continue;
    insSession.run(parsed.row);
    delFts.run(id);
    for (const m of parsed.fts) insFts.run(m.session_id, m.ts, m.role, m.project, m.body);
    changed++;
  }
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
 * @returns {object[]}
 */
export function projects() {
  const d = getDb();
  reindex();
  const overrides = loadOverrides(d);
  const rows = d.prepare(
    `SELECT id, cwd, project, msg_count,
            in_tok+out_tok+cache_read+cache_create AS tokens,
            first_ts, last_ts, cost
     FROM sessions`
  ).all();
  return groupByProject(rows, overrides)
    .map((g) => ({
      project: g.project, name: g.name, cwd: g.cwd,
      sessions: g.sessions, messages: g.messages, tokens: g.tokens,
      last_ts: g.updated, created: g.created, cost: g.cost,
    }))
    .sort((a, b) => (b.last_ts || '').localeCompare(a.last_ts || ''));
}

/**
 * Manually assign a session to a project, or clear the assignment.
 * @param {string} id
 * @param {?string} projectKey
 * @returns {{id: string, project_key: string|null}}
 */
export function setOverride(id, projectKey) {
  const d = getDb();
  if (!projectKey) {
    d.prepare('DELETE FROM session_overrides WHERE id = ?').run(id);
    return { id, project_key: null };
  }
  d.prepare('INSERT OR REPLACE INTO session_overrides (id, project_key) VALUES (?, ?)')
    .run(id, projectKey);
  return { id, project_key: projectKey };
}

/** List all manual session→project assignments. */
export function listOverrides() {
  const d = getDb();
  return d.prepare('SELECT id, project_key FROM session_overrides').all();
}

/**
 * List sessions, optionally filtered to one canonical project.
 * @param {string} [project]
 * @returns {object[]}
 */
export function sessions(project) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, id AS sessionId, source, project, cwd, git_branch, first_ts, last_ts,
           msg_count, user_count, asst_count, models, summary,
           in_tok, out_tok, cache_read, cache_create, cost
    FROM sessions
    ORDER BY last_ts DESC
  `).all();
  const overrides = loadOverrides(d);
  const filtered = project
    ? rows.filter((r) => resolveProject(r, overrides).key === project)
    : rows;
  return filtered.map((r) => ({
    ...r,
    source: r.source || 'claude',
    summary: stripCmdTags(r.summary),
  }));
}

/** Full transcript read fresh from the source (normalized records). */
export function session(id) {
  const d = getDb();
  const meta = d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!meta) return null;
  meta.summary = stripCmdTags(meta.summary);
  meta.source = meta.source || 'claude';
  const overrides = loadOverrides(d);
  const resolved = resolveProject(meta, overrides);
  meta.project_key = resolved.key;
  meta.project_name = resolved.name;
  meta.overridden = overrides.has(meta.id);

  let records = [];
  try {
    if (meta.source === 'grok') {
      records = grokUpdatesToRecords(meta.file);
    } else {
      records = readFileSync(meta.file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch { /* file gone */ }
  return { meta, records };
}

export function search(q, project, limit = 100) {
  if (!q || !q.trim()) return [];
  const d = getDb();
  reindex();
  const match = q.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
  const sql = `
    SELECT f.session_id AS id, f.project, f.ts, f.role,
           snippet(msg_fts, 4, '[', ']', ' … ', 12) AS snippet,
           s.summary, s.cwd, s.source
    FROM msg_fts f JOIN sessions s ON s.id = f.session_id
    WHERE msg_fts MATCH ?
    ORDER BY f.ts DESC ${project ? '' : 'LIMIT ?'}`;
  try {
    let rows = project ? d.prepare(sql).all(match) : d.prepare(sql).all(match, limit);
    if (project) {
      const overrides = loadOverrides(d);
      rows = rows
        .filter((r) => resolveProject(r, overrides).key === project)
        .slice(0, limit);
    }
    return rows.map((r) => ({
      ...r,
      source: r.source || 'claude',
      name: basename(r.cwd || r.project),
      summary: stripCmdTags(r.summary),
    }));
  } catch {
    return [];
  }
}

/**
 * Aggregate usage stats across all indexed sessions.
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
    SELECT id, cwd, project, msg_count,
           in_tok+out_tok+cache_read+cache_create AS tokens,
           cost, first_ts, last_ts
    FROM sessions`).all(), loadOverrides(d))
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

// re-export path constants for tests
export { CLAUDE_DIR, PROJECTS_DIR, GROK_SESSIONS, GROK_HOME };
