//! Coding-agent session index.
//!
//! Port of `backend/cc-index.js`. Walks Claude JSONL transcripts and Grok
//! session directories, stores metadata plus an FTS5 body index in
//! `databases/ccindex.db`, and serves the `/api/cc/*` routes. Full transcripts
//! are read from disk when a session is opened, not from the index.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::config;
use crate::db::{self, Db, DbError, Row, Value};
use crate::json::{self, Json};

const FTS_BODY_CHARS: usize = 20_000;
const SUMMARY_CHARS: usize = 200;
const LONG_CONTEXT_TOKENS: f64 = 200_000.0;

/// Where transcripts live on disk. Snapshotted when the index opens.
struct Roots {
    claude_dir: PathBuf,
    grok_sessions: PathBuf,
}

impl Roots {
    /// Claude projects under `~/.claude/projects`, Grok sessions under
    /// `$GROK_HOME/sessions` (default `~/.grok/sessions`).
    ///
    /// `SESSION_REVIEW_CLAUDE_DIR` overrides the Claude directory so tests do
    /// not scan the operator's real transcripts.
    fn from_env() -> Roots {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let claude = config::env_nonempty("SESSION_REVIEW_CLAUDE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude").join("projects"));
        let grok_home = config::env_nonempty("GROK_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".grok"));
        Roots {
            claude_dir: claude,
            grok_sessions: grok_home.join("sessions"),
        }
    }
}

/// One transcript the walker decided is worth indexing.
struct Listed {
    source: String,
    id: String,
    file: PathBuf,
    project: String,
    cwd: String,
    mtime: f64,
}

/// Metadata row written to `sessions`.
struct Indexed {
    id: String,
    file: String,
    source: String,
    project: String,
    cwd: String,
    git_branch: String,
    first_ts: String,
    last_ts: String,
    msg_count: i64,
    user_count: i64,
    asst_count: i64,
    models: String,
    summary: String,
    in_tok: i64,
    out_tok: i64,
    cache_read: i64,
    cache_create: i64,
    cost: f64,
    mtime: f64,
}

/// One FTS row. `project` is the raw folder name, not the canonical path.
struct FtsHit {
    session_id: String,
    ts: String,
    role: String,
    project: String,
    body: String,
}

/// Open session index. One SQLite connection, guarded because the HTTP server
/// is multi-threaded and [`Db`] is not [`Sync`].
pub struct SessionIndex {
    db: Mutex<Option<Db>>,
    roots: Roots,
}

impl SessionIndex {
    /// Open (or create) the index at `path` and ensure its schema.
    ///
    /// # Errors
    /// Returns [`DbError`] when the directory cannot be created, SQLite cannot
    /// open the file, or FTS5 is unavailable.
    pub fn open(path: &Path) -> Result<SessionIndex, DbError> {
        SessionIndex::open_with(path, Roots::from_env())
    }

    fn open_with(path: &Path, roots: Roots) -> Result<SessionIndex, DbError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| {
                    DbError::local(format!(
                        "failed to create session index directory {}: {e}",
                        parent.display()
                    ))
                })?;
            }
        }
        let db = Db::open(&path.to_string_lossy())?;
        db::ensure_session_index(&db)?;
        Ok(SessionIndex {
            db: Mutex::new(Some(db)),
            roots,
        })
    }

    /// Close the connection. Later calls fail with a local database error.
    pub fn close(&self) {
        self.lock().take();
    }

    /// Aggregated projects. Refreshes the index first.
    ///
    /// # Errors
    /// Returns [`DbError`] when the refresh or the read fails.
    pub fn projects(&self) -> Result<Json, DbError> {
        let guard = self.lock();
        let db = open_db(&guard)?;
        reindex_db(db, &self.roots, false)?;
        query_projects(db)
    }

    /// Session rows, optionally limited to one canonical project key.
    ///
    /// Does not refresh the index. Matches the Node handler, which only
    /// reindexed on projects, search, stats, and the explicit reindex route.
    ///
    /// # Errors
    /// Returns [`DbError`] when the read fails.
    pub fn sessions(&self, project: Option<&str>) -> Result<Json, DbError> {
        let guard = self.lock();
        let db = open_db(&guard)?;
        query_sessions(db, project)
    }

    /// Metadata plus a fresh transcript. `None` when the id is not indexed.
    ///
    /// # Errors
    /// Returns [`DbError`] when the metadata read fails. A missing transcript
    /// file is an empty `records` array, not an error.
    pub fn session(&self, id: &str) -> Result<Option<Json>, DbError> {
        let guard = self.lock();
        let db = open_db(&guard)?;
        query_session(db, id)
    }

    /// FTS search. An empty query is `[]` and does not refresh the index.
    /// A bad FTS expression is also `[]`, matching the Node `catch`.
    ///
    /// # Errors
    /// Returns [`DbError`] when the refresh itself fails.
    pub fn search(&self, q: &str, project: Option<&str>, limit: i64) -> Result<Json, DbError> {
        if q.trim().is_empty() {
            return Ok(Json::Arr(Vec::new()));
        }
        let guard = self.lock();
        let db = open_db(&guard)?;
        reindex_db(db, &self.roots, false)?;
        Ok(query_search(db, q, project, limit).unwrap_or_else(|_| Json::Arr(Vec::new())))
    }

    /// Totals and the project, model, and day rollups. Refreshes first.
    ///
    /// # Errors
    /// Returns [`DbError`] when the refresh or a rollup query fails.
    pub fn stats(&self) -> Result<Json, DbError> {
        let guard = self.lock();
        let db = open_db(&guard)?;
        reindex_db(db, &self.roots, false)?;
        query_stats(db)
    }

    /// Rescan transcripts. `force` ignores mtime and rewrites every row.
    ///
    /// # Errors
    /// Returns [`DbError`] when the write fails. The response is
    /// `{ "files", "changed" }`.
    pub fn reindex(&self, force: bool) -> Result<Json, DbError> {
        let guard = self.lock();
        let db = open_db(&guard)?;
        let (files, changed) = reindex_db(db, &self.roots, force)?;
        Ok(obj([
            ("files", json::i(files)),
            ("changed", json::i(changed)),
        ]))
    }

    fn lock(&self) -> MutexGuard<'_, Option<Db>> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn open_db(guard: &Option<Db>) -> Result<&Db, DbError> {
    guard
        .as_ref()
        .ok_or_else(|| DbError::local("session index is closed"))
}

fn obj<const N: usize>(pairs: [(&str, Json); N]) -> Json {
    json::obj(pairs)
}

fn map_obj(pairs: Vec<(&str, Json)>) -> Json {
    let mut map = BTreeMap::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Json::Obj(map)
}

// ==== INDEX ====

fn reindex_db(db: &Db, roots: &Roots, force: bool) -> Result<(i64, i64), DbError> {
    let files = list_files(roots);
    in_tx(db, |db| {
        let known = load_mtimes(db)?;
        let mut seen = HashSet::new();
        let mut changed = 0i64;
        for file in &files {
            seen.insert(file.id.clone());
            let unchanged = known
                .get(&file.id)
                .is_some_and(|mtime| !force && *mtime == file.mtime);
            if unchanged {
                continue;
            }
            let Some(parsed) = parse_entry(file) else {
                continue;
            };
            write_session(db, &parsed.0, &parsed.1)?;
            changed += 1;
        }
        for id in known.keys() {
            if !seen.contains(id) {
                db.run("DELETE FROM sessions WHERE id = ?", &[Value::Text(id.clone())])?;
                db.run(
                    "DELETE FROM msg_fts WHERE session_id = ?",
                    &[Value::Text(id.clone())],
                )?;
            }
        }
        Ok((files.len() as i64, changed))
    })
}

fn in_tx<T>(db: &Db, f: impl FnOnce(&Db) -> Result<T, DbError>) -> Result<T, DbError> {
    db.exec("BEGIN IMMEDIATE")?;
    match f(db) {
        Ok(value) => match db.exec("COMMIT") {
            Ok(()) => Ok(value),
            Err(err) => {
                let _ = db.exec("ROLLBACK");
                Err(err)
            }
        },
        Err(err) => {
            let _ = db.exec("ROLLBACK");
            Err(err)
        }
    }
}

fn load_mtimes(db: &Db) -> Result<HashMap<String, f64>, DbError> {
    let mut out = HashMap::new();
    for row in db.query("SELECT id, mtime FROM sessions", &[])? {
        let Some(id) = row.text("id").map(str::to_string) else {
            continue;
        };
        if let Some(mtime) = cell_f64(&row, "mtime") {
            out.insert(id, mtime);
        }
    }
    Ok(out)
}

fn write_session(db: &Db, row: &Indexed, hits: &[FtsHit]) -> Result<(), DbError> {
    db.run(
        "INSERT OR REPLACE INTO sessions
         (id, file, project, cwd, git_branch, first_ts, last_ts, msg_count, user_count, asst_count,
          models, summary, in_tok, out_tok, cache_read, cache_create, cost, mtime, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::Text(row.id.clone()),
            Value::Text(row.file.clone()),
            Value::Text(row.project.clone()),
            Value::Text(row.cwd.clone()),
            Value::Text(row.git_branch.clone()),
            Value::Text(row.first_ts.clone()),
            Value::Text(row.last_ts.clone()),
            Value::Int(row.msg_count),
            Value::Int(row.user_count),
            Value::Int(row.asst_count),
            Value::Text(row.models.clone()),
            Value::Text(row.summary.clone()),
            Value::Int(row.in_tok),
            Value::Int(row.out_tok),
            Value::Int(row.cache_read),
            Value::Int(row.cache_create),
            Value::Real(row.cost),
            Value::Real(row.mtime),
            Value::Text(row.source.clone()),
        ],
    )?;
    db.run(
        "DELETE FROM msg_fts WHERE session_id = ?",
        &[Value::Text(row.id.clone())],
    )?;
    for hit in hits {
        db.run(
            "INSERT INTO msg_fts (session_id, ts, role, project, body) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::Text(hit.session_id.clone()),
                Value::Text(hit.ts.clone()),
                Value::Text(hit.role.clone()),
                Value::Text(hit.project.clone()),
                Value::Text(hit.body.clone()),
            ],
        )?;
    }
    Ok(())
}

fn list_files(roots: &Roots) -> Vec<Listed> {
    let mut out = list_claude(&roots.claude_dir);
    out.extend(list_grok(&roots.grok_sessions));
    out
}

fn list_claude(dir: &Path) -> Vec<Listed> {
    let mut out = Vec::new();
    let Ok(projects) = fs::read_dir(dir) else {
        return out;
    };
    for project in projects.flatten() {
        let path = project.path();
        if !path.is_dir() {
            continue;
        }
        let project_name = project.file_name().to_string_lossy().into_owned();
        let Ok(files) = fs::read_dir(&path) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let file_path = file.path();
            let Some(mtime) = mtime_ms(&file_path) else {
                continue;
            };
            let id = name.trim_end_matches(".jsonl").to_string();
            out.push(Listed {
                source: "claude".into(),
                id,
                file: file_path,
                project: project_name.clone(),
                cwd: String::new(),
                mtime,
            });
        }
    }
    out
}

fn list_grok(dir: &Path) -> Vec<Listed> {
    let mut out = Vec::new();
    let Ok(groups) = fs::read_dir(dir) else {
        return out;
    };
    for group in groups.flatten() {
        let name = group.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.ends_with(".sqlite") || name.ends_with(".db") {
            continue;
        }
        let group_dir = group.path();
        if !group_dir.is_dir() {
            continue;
        }
        let cwd = decode_grok_cwd(&name, &group_dir);
        let Ok(sessions) = fs::read_dir(&group_dir) else {
            continue;
        };
        for session in sessions.flatten() {
            let sid = session.file_name().to_string_lossy().into_owned();
            if sid.starts_with('.') {
                continue;
            }
            let session_dir = session.path();
            if !session_dir.is_dir() {
                continue;
            }
            let updates = session_dir.join("updates.jsonl");
            let summary = session_dir.join("summary.json");
            if !updates.is_file() && !summary.is_file() {
                continue;
            }
            let mtime = mtime_ms(&updates)
                .or_else(|| mtime_ms(&summary))
                .or_else(|| mtime_ms(&session_dir))
                .unwrap_or(0.0);
            out.push(Listed {
                source: "grok".into(),
                id: sid,
                file: session_dir,
                project: name.clone(),
                cwd: cwd.clone(),
                mtime,
            });
        }
    }
    out
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_secs_f64() * 1000.0)
}

fn parse_entry(entry: &Listed) -> Option<(Indexed, Vec<FtsHit>)> {
    if entry.source == "grok" {
        Some(parse_grok(entry))
    } else {
        parse_claude(entry)
    }
}

fn parse_claude(entry: &Listed) -> Option<(Indexed, Vec<FtsHit>)> {
    let text = fs::read_to_string(&entry.file).ok()?;
    let mut row = Indexed {
        id: entry.id.clone(),
        file: entry.file.display().to_string(),
        source: "claude".into(),
        project: entry.project.clone(),
        cwd: String::new(),
        git_branch: String::new(),
        first_ts: String::new(),
        last_ts: String::new(),
        msg_count: 0,
        user_count: 0,
        asst_count: 0,
        models: String::new(),
        summary: String::new(),
        in_tok: 0,
        out_tok: 0,
        cache_read: 0,
        cache_create: 0,
        cost: 0.0,
        mtime: entry.mtime,
    };
    let mut models = Vec::new();
    let mut hits = Vec::new();
    let mut first_user = String::new();
    let mut seen_usage = HashSet::new();
    let mut seen_asst = HashSet::new();

    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(rec) = json::parse(line.as_bytes()) else {
            continue;
        };
        let kind = rec.get_str("type").unwrap_or("");
        if row.cwd.is_empty() {
            if let Some(cwd) = rec.get_str("cwd") {
                if !cwd.is_empty() {
                    row.cwd = cwd.to_string();
                }
            }
        }
        if row.git_branch.is_empty() {
            if let Some(branch) = rec.get_str("gitBranch") {
                if !branch.is_empty() {
                    row.git_branch = branch.to_string();
                }
            }
        }
        if let Some(ts) = present_ts(rec.get("timestamp")) {
            if row.first_ts.is_empty() {
                row.first_ts = ts.clone();
            }
            row.last_ts = ts;
        }
        if kind == "summary" {
            if let Some(summary) = rec.get_str("summary") {
                if !summary.is_empty() {
                    row.summary = summary.to_string();
                }
            }
            continue;
        }
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let msg_id = json_id(rec.get("message").and_then(|msg| msg.get("id")));
        if kind == "assistant" {
            let msg = rec.get("message");
            if let Some(model) = msg.and_then(|m| m.get_str("model")) {
                push_unique(&mut models, model);
            }
            let fresh = msg_id.as_ref().is_none_or(|id| !seen_usage.contains(id));
            if fresh {
                if let Some(id) = &msg_id {
                    seen_usage.insert(id.clone());
                }
                let usage = msg.and_then(|m| m.get("usage"));
                row.in_tok += num_i64(usage.and_then(|u| u.get("input_tokens")));
                row.out_tok += num_i64(usage.and_then(|u| u.get("output_tokens")));
                row.cache_read += num_i64(usage.and_then(|u| u.get("cache_read_input_tokens")));
                row.cache_create += num_i64(usage.and_then(|u| u.get("cache_creation_input_tokens")));
            }
        }
        if is_conversational(&rec) {
            if kind == "user" {
                row.msg_count += 1;
                row.user_count += 1;
            } else {
                let fresh = msg_id.as_ref().is_none_or(|id| !seen_asst.contains(id));
                if fresh {
                    if let Some(id) = &msg_id {
                        seen_asst.insert(id.clone());
                    }
                    row.msg_count += 1;
                    row.asst_count += 1;
                }
            }
        }
        let body = take_chars(&extract_text(&rec), FTS_BODY_CHARS);
        if kind == "user" && first_user.is_empty() && !body.trim().is_empty() {
            first_user = body.trim().to_string();
        }
        if !body.trim().is_empty() {
            hits.push(FtsHit {
                session_id: entry.id.clone(),
                ts: present_ts(rec.get("timestamp")).unwrap_or_default(),
                role: kind.to_string(),
                project: entry.project.clone(),
                body,
            });
        }
    }

    let model = models.first().map(String::as_str).unwrap_or("");
    row.cost = cost_of(
        row.in_tok as f64,
        row.out_tok as f64,
        row.cache_create as f64,
        row.cache_read as f64,
        model,
    );
    row.models = models.join(",");
    if row.summary.is_empty() {
        row.summary = take_chars(&first_user, SUMMARY_CHARS);
    }
    if row.cwd.is_empty() {
        row.cwd = entry.project.clone();
    }
    Some((row, hits))
}

fn parse_grok(entry: &Listed) -> (Indexed, Vec<FtsHit>) {
    let summary = fs::read_to_string(entry.file.join("summary.json"))
        .ok()
        .and_then(|text| json::parse(text.as_bytes()).ok())
        .unwrap_or(Json::Obj(BTreeMap::new()));
    let cwd = summary
        .get("info")
        .and_then(|info| info.get_str("cwd"))
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or(&entry.cwd)
        .to_string();
    let mut models = Vec::new();
    if let Some(model) = summary.get_str("current_model_id") {
        push_unique(&mut models, model);
    }
    let mut row = Indexed {
        id: entry.id.clone(),
        file: entry.file.display().to_string(),
        source: "grok".into(),
        project: entry.project.clone(),
        cwd,
        git_branch: summary.get_str("head_branch").unwrap_or("").to_string(),
        first_ts: to_iso_value(summary.get("created_at")),
        last_ts: {
            let updated = to_iso_value(summary.get("updated_at"));
            if updated.is_empty() {
                to_iso_value(summary.get("last_active_at"))
            } else {
                updated
            }
        },
        msg_count: 0,
        user_count: 0,
        asst_count: 0,
        models: String::new(),
        summary: summary
            .get_str("generated_title")
            .filter(|s| !s.is_empty())
            .or_else(|| summary.get_str("session_summary"))
            .unwrap_or("")
            .to_string(),
        in_tok: 0,
        out_tok: 0,
        cache_read: 0,
        cache_create: 0,
        cost: 0.0,
        mtime: entry.mtime,
    };
    let mut hits = Vec::new();
    let mut user_count = 0i64;
    let mut asst_count = 0i64;
    let mut first_user = String::new();
    let mut user_buf = String::new();
    let mut asst_buf = String::new();

    if let Ok(text) = fs::read_to_string(entry.file.join("updates.jsonl")) {
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(record) = json::parse(line.as_bytes()) else {
                continue;
            };
            let Some(update) = record.get("params").and_then(|p| p.get("update")) else {
                continue;
            };
            if update.as_obj().is_none() {
                continue;
            }
            let kind = update.get_str("sessionUpdate").unwrap_or("");
            let meta = record.get("params").and_then(|p| p.get("_meta"));
            let ts = to_iso_js(record.get("timestamp"), meta.and_then(|m| m.get("agentTimestampMs")));
            if !ts.is_empty() {
                if row.first_ts.is_empty() {
                    row.first_ts = ts.clone();
                }
                row.last_ts = ts.clone();
            }
            match kind {
                "user_message_chunk" => {
                    if let Some(text) = update.get("content").and_then(|c| c.get_str("text")) {
                        user_buf.push_str(text);
                    }
                }
                "agent_message_chunk" | "agent_thought_chunk" => {
                    if let Some(text) = update.get("content").and_then(|c| c.get_str("text")) {
                        asst_buf.push_str(text);
                    }
                    flush_grok_user(
                        &mut user_buf,
                        &mut first_user,
                        &mut user_count,
                        &mut hits,
                        entry,
                        &ts,
                    );
                }
                "tool_call" | "tool_call_update" => {
                    let body = take_chars(
                        &format!(
                            "{} {}",
                            grok_tool_name(update),
                            stringify_grok_output(update)
                        )
                        .trim()
                        .to_string(),
                        FTS_BODY_CHARS,
                    );
                    if !body.trim().is_empty() {
                        hits.push(FtsHit {
                            session_id: entry.id.clone(),
                            ts: ts.clone(),
                            role: "assistant".into(),
                            project: entry.project.clone(),
                            body,
                        });
                    }
                }
                "turn_completed" => {
                    flush_grok_user(
                        &mut user_buf,
                        &mut first_user,
                        &mut user_count,
                        &mut hits,
                        entry,
                        &ts,
                    );
                    if !asst_buf.trim().is_empty() {
                        hits.push(FtsHit {
                            session_id: entry.id.clone(),
                            ts: ts.clone(),
                            role: "assistant".into(),
                            project: entry.project.clone(),
                            body: take_chars(&asst_buf, FTS_BODY_CHARS),
                        });
                        asst_count += 1;
                        asst_buf.clear();
                    }
                    if let Some(usage) = update.get("usage") {
                        let input = num_i64(usage.get("inputTokens"));
                        let cached = num_i64(usage.get("cachedReadTokens"));
                        row.in_tok += (input - cached).max(0);
                        row.out_tok += num_i64(usage.get("outputTokens"));
                        row.cache_read += cached;
                        if let Some(Json::Obj(models_used)) = usage.get("modelUsage") {
                            for model in models_used.keys() {
                                push_unique(&mut models, model);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    flush_grok_user(
        &mut user_buf,
        &mut first_user,
        &mut user_count,
        &mut hits,
        entry,
        &row.last_ts.clone(),
    );
    if !asst_buf.trim().is_empty() {
        hits.push(FtsHit {
            session_id: entry.id.clone(),
            ts: row.last_ts.clone(),
            role: "assistant".into(),
            project: entry.project.clone(),
            body: take_chars(&asst_buf, FTS_BODY_CHARS),
        });
        asst_count += 1;
    }

    row.user_count = if user_count > 0 {
        user_count
    } else {
        num_i64(summary.get("num_chat_messages"))
    };
    row.asst_count = asst_count;
    let summed = row.user_count + row.asst_count;
    row.msg_count = if summed > 0 {
        summed
    } else {
        num_i64(summary.get("num_messages"))
    };
    if row.summary.is_empty() {
        row.summary = take_chars(&first_user, SUMMARY_CHARS);
    }
    let model = models.first().map(String::as_str).unwrap_or("");
    row.cost = cost_of(
        row.in_tok as f64,
        row.out_tok as f64,
        row.cache_create as f64,
        row.cache_read as f64,
        model,
    );
    row.models = models.join(",");
    if row.cwd.is_empty() {
        row.cwd = if entry.cwd.is_empty() {
            entry.project.clone()
        } else {
            entry.cwd.clone()
        };
    }
    (row, hits)
}

fn flush_grok_user(
    user_buf: &mut String,
    first_user: &mut String,
    user_count: &mut i64,
    hits: &mut Vec<FtsHit>,
    entry: &Listed,
    ts: &str,
) {
    if user_buf.trim().is_empty() {
        return;
    }
    if first_user.is_empty() {
        *first_user = user_buf.trim().to_string();
    }
    hits.push(FtsHit {
        session_id: entry.id.clone(),
        ts: ts.to_string(),
        role: "user".into(),
        project: entry.project.clone(),
        body: take_chars(user_buf, FTS_BODY_CHARS),
    });
    *user_count += 1;
    user_buf.clear();
}

// ==== READS ====

fn query_projects(db: &Db) -> Result<Json, DbError> {
    let overrides = load_overrides(db)?;
    let rows = db.query(
        "SELECT id, cwd, project, msg_count, in_tok+out_tok+cache_read+cache_create AS tokens,
                first_ts, last_ts, cost
         FROM sessions",
        &[],
    )?;
    let mut groups = group_projects(&rows, &overrides);
    groups.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(Json::Arr(
        groups
            .into_iter()
            .map(|group| {
                obj([
                    ("project", json::s(group.project)),
                    ("name", json::s(group.name)),
                    ("cwd", json::s(group.cwd)),
                    ("sessions", json::i(group.sessions)),
                    ("messages", json::i(group.messages)),
                    ("tokens", json::i(group.tokens)),
                    ("last_ts", json::s(group.updated)),
                    ("created", json::s(group.created)),
                    ("cost", Json::Num(group.cost)),
                ])
            })
            .collect(),
    ))
}

fn query_sessions(db: &Db, project: Option<&str>) -> Result<Json, DbError> {
    let overrides = load_overrides(db)?;
    let rows = db.query(
        "SELECT id, source, project, cwd, git_branch, first_ts, last_ts, msg_count, user_count,
                asst_count, models, summary, in_tok, out_tok, cache_read, cache_create, cost
         FROM sessions ORDER BY last_ts DESC",
        &[],
    )?;
    let mut out = Vec::new();
    for row in rows {
        let id = cell_text(&row, "id");
        let cwd = cell_text(&row, "cwd");
        let project_name = cell_text(&row, "project");
        let (key, _, _) = resolve_project(&id, &cwd, &project_name, &overrides);
        if let Some(filter) = project {
            if key != filter {
                continue;
            }
        }
        out.push(obj([
            ("id", json::s(id.clone())),
            ("sessionId", json::s(id)),
            ("source", json::s(source_or_claude(&row))),
            ("project", json::s(project_name)),
            ("cwd", json::s(cwd)),
            ("git_branch", json::s(cell_text(&row, "git_branch"))),
            ("first_ts", json::s(cell_text(&row, "first_ts"))),
            ("last_ts", json::s(cell_text(&row, "last_ts"))),
            ("msg_count", json::i(cell_i64(&row, "msg_count"))),
            ("user_count", json::i(cell_i64(&row, "user_count"))),
            ("asst_count", json::i(cell_i64(&row, "asst_count"))),
            ("models", json::s(cell_text(&row, "models"))),
            ("summary", json::s(strip_cmd_tags(&cell_text(&row, "summary")))),
            ("in_tok", json::i(cell_i64(&row, "in_tok"))),
            ("out_tok", json::i(cell_i64(&row, "out_tok"))),
            ("cache_read", json::i(cell_i64(&row, "cache_read"))),
            ("cache_create", json::i(cell_i64(&row, "cache_create"))),
            ("cost", Json::Num(cell_f64(&row, "cost").unwrap_or(0.0))),
        ]));
    }
    Ok(Json::Arr(out))
}

fn query_session(db: &Db, id: &str) -> Result<Option<Json>, DbError> {
    let rows = db.query(
        "SELECT id, file, project, cwd, git_branch, first_ts, last_ts, msg_count, user_count,
                asst_count, models, summary, in_tok, out_tok, cache_read, cache_create, cost,
                mtime, source
         FROM sessions WHERE id = ?",
        &[Value::Text(id.to_string())],
    )?;
    let Some(row) = rows.into_iter().next() else {
        return Ok(None);
    };
    let overrides = load_overrides(db)?;
    let sid = cell_text(&row, "id");
    let cwd = cell_text(&row, "cwd");
    let project = cell_text(&row, "project");
    let (key, name, overridden) = resolve_project(&sid, &cwd, &project, &overrides);
    let source = source_or_claude(&row);
    let file = cell_text(&row, "file");
    let records = if source == "grok" {
        grok_updates_to_records(Path::new(&file))
    } else {
        read_claude_records(Path::new(&file))
    };
    let meta = map_obj(vec![
        ("id", json::s(sid)),
        ("file", json::s(file)),
        ("project", json::s(project)),
        ("cwd", json::s(cwd)),
        ("git_branch", json::s(cell_text(&row, "git_branch"))),
        ("first_ts", json::s(cell_text(&row, "first_ts"))),
        ("last_ts", json::s(cell_text(&row, "last_ts"))),
        ("msg_count", json::i(cell_i64(&row, "msg_count"))),
        ("user_count", json::i(cell_i64(&row, "user_count"))),
        ("asst_count", json::i(cell_i64(&row, "asst_count"))),
        ("models", json::s(cell_text(&row, "models"))),
        ("summary", json::s(strip_cmd_tags(&cell_text(&row, "summary")))),
        ("in_tok", json::i(cell_i64(&row, "in_tok"))),
        ("out_tok", json::i(cell_i64(&row, "out_tok"))),
        ("cache_read", json::i(cell_i64(&row, "cache_read"))),
        ("cache_create", json::i(cell_i64(&row, "cache_create"))),
        ("cost", Json::Num(cell_f64(&row, "cost").unwrap_or(0.0))),
        ("mtime", Json::Num(cell_f64(&row, "mtime").unwrap_or(0.0))),
        ("source", json::s(source)),
        ("project_key", json::s(key)),
        ("project_name", json::s(name)),
        ("overridden", Json::Bool(overridden)),
    ]);
    Ok(Some(obj([("meta", meta), ("records", Json::Arr(records))])))
}

fn query_search(db: &Db, q: &str, project: Option<&str>, limit: i64) -> Result<Json, DbError> {
    let pattern = fts_match(q);
    let sql = "SELECT f.session_id AS id, f.project, f.ts, f.role,
                      snippet(msg_fts, 4, '[', ']', ' … ', 12) AS snippet,
                      s.summary, s.cwd, s.source
               FROM msg_fts f JOIN sessions s ON s.id = f.session_id
               WHERE msg_fts MATCH ?
               ORDER BY f.ts DESC";
    let rows = if project.is_some() {
        db.query(sql, &[Value::Text(pattern)])?
    } else {
        db.query(
            &format!("{sql} LIMIT ?"),
            &[Value::Text(pattern), Value::Int(limit)],
        )?
    };
    let overrides = if project.is_some() {
        load_overrides(db)?
    } else {
        HashMap::new()
    };
    let mut mapped = Vec::new();
    for row in rows {
        let id = cell_text(&row, "id");
        let cwd = cell_text(&row, "cwd");
        let project_name = cell_text(&row, "project");
        if let Some(filter) = project {
            let (key, _, _) = resolve_project(&id, &cwd, &project_name, &overrides);
            if key != filter {
                continue;
            }
        }
        let name_src = if cwd.is_empty() { project_name.as_str() } else { cwd.as_str() };
        let base = base_name(name_src);
        let name = if base.is_empty() { name_src.to_string() } else { base.to_string() };
        mapped.push(obj([
            ("id", json::s(id)),
            ("project", json::s(project_name)),
            ("ts", json::s(cell_text(&row, "ts"))),
            ("role", json::s(cell_text(&row, "role"))),
            ("snippet", json::s(cell_text(&row, "snippet"))),
            ("summary", json::s(strip_cmd_tags(&cell_text(&row, "summary")))),
            ("cwd", json::s(cwd)),
            ("source", json::s(source_or_claude(&row))),
            ("name", json::s(name)),
        ]));
    }
    if project.is_some() {
        let end = js_slice_end(mapped.len(), limit);
        mapped.truncate(end);
    }
    Ok(Json::Arr(mapped))
}

fn query_stats(db: &Db) -> Result<Json, DbError> {
    let totals_rows = db.query(
        "SELECT COUNT(*) AS sessions, SUM(msg_count) AS messages,
                SUM(in_tok+out_tok+cache_read+cache_create) AS tokens, SUM(cost) AS cost
         FROM sessions",
        &[],
    )?;
    let totals = totals_rows
        .first()
        .map(|row| {
            obj([
                ("sessions", sql_num(row, "sessions")),
                ("messages", sql_num(row, "messages")),
                ("tokens", sql_num(row, "tokens")),
                ("cost", sql_num(row, "cost")),
            ])
        })
        .unwrap_or_else(|| {
            obj([
                ("sessions", json::i(0)),
                ("messages", Json::Null),
                ("tokens", Json::Null),
                ("cost", Json::Null),
            ])
        });
    let project_rows = db.query(
        "SELECT id, cwd, project, msg_count, in_tok+out_tok+cache_read+cache_create AS tokens,
                cost, first_ts, last_ts
         FROM sessions",
        &[],
    )?;
    let overrides = load_overrides(db)?;
    let mut by_project = group_projects(&project_rows, &overrides);
    by_project.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
    let by_project = by_project
        .into_iter()
        .map(|group| {
            obj([
                ("project", json::s(group.project)),
                ("name", json::s(group.name)),
                ("cwd", json::s(group.cwd)),
                ("sessions", json::i(group.sessions)),
                ("messages", json::i(group.messages)),
                ("tokens", json::i(group.tokens)),
                ("cost", Json::Num(group.cost)),
                ("created", json::s(group.created)),
                ("updated", json::s(group.updated)),
            ])
        })
        .collect();
    let by_model = db
        .query(
            "SELECT models, COUNT(*) AS sessions, SUM(out_tok) AS out_tok, SUM(cost) AS cost
             FROM sessions WHERE models <> '' GROUP BY models ORDER BY cost DESC",
            &[],
        )?
        .iter()
        .map(|row| {
            obj([
                ("models", json::s(cell_text(row, "models"))),
                ("sessions", sql_num(row, "sessions")),
                ("out_tok", sql_num(row, "out_tok")),
                ("cost", sql_num(row, "cost")),
            ])
        })
        .collect();
    let by_day = db
        .query(
            "SELECT substr(last_ts, 1, 10) AS day, COUNT(*) AS sessions, SUM(msg_count) AS messages,
                    SUM(in_tok+out_tok+cache_read+cache_create) AS tokens, SUM(cost) AS cost
             FROM sessions WHERE last_ts <> '' GROUP BY day ORDER BY day DESC",
            &[],
        )?
        .iter()
        .map(|row| {
            obj([
                ("day", json::s(cell_text(row, "day"))),
                ("sessions", sql_num(row, "sessions")),
                ("messages", sql_num(row, "messages")),
                ("tokens", sql_num(row, "tokens")),
                ("cost", sql_num(row, "cost")),
            ])
        })
        .collect();
    Ok(obj([
        ("totals", totals),
        ("byProject", Json::Arr(by_project)),
        ("byModel", Json::Arr(by_model)),
        ("byDay", Json::Arr(by_day)),
    ]))
}

struct ProjectGroup {
    project: String,
    name: String,
    cwd: String,
    sessions: i64,
    messages: i64,
    tokens: i64,
    cost: f64,
    created: String,
    updated: String,
}

fn group_projects(rows: &[Row], overrides: &HashMap<String, String>) -> Vec<ProjectGroup> {
    let mut groups: Vec<ProjectGroup> = Vec::new();
    for row in rows {
        let id = cell_text(row, "id");
        let cwd = cell_text(row, "cwd");
        let project = cell_text(row, "project");
        let (key, name) = {
            let (key, name, _) = resolve_project(&id, &cwd, &project, overrides);
            (key, name)
        };
        let messages = cell_i64(row, "msg_count");
        let tokens = cell_i64(row, "tokens");
        let cost = cell_f64(row, "cost").unwrap_or(0.0);
        let first = cell_text(row, "first_ts");
        let last = cell_text(row, "last_ts");
        if let Some(group) = groups.iter_mut().find(|group| group.project == key) {
            group.sessions += 1;
            group.messages += messages;
            group.tokens += tokens;
            group.cost += cost;
            if !first.is_empty() && (group.created.is_empty() || first < group.created) {
                group.created = first;
            }
            if !last.is_empty() && last > group.updated {
                group.updated = last;
            }
        } else {
            groups.push(ProjectGroup {
                project: key,
                name,
                cwd: {
                    let (key, _, _) = resolve_project(&id, &cwd, &project, overrides);
                    key
                },
                sessions: 1,
                messages,
                tokens,
                cost,
                created: first,
                updated: last,
            });
        }
    }
    groups
}

fn load_overrides(db: &Db) -> Result<HashMap<String, String>, DbError> {
    let mut map = HashMap::new();
    for row in db.query("SELECT id, project_key FROM session_overrides", &[])? {
        if let (Some(id), Some(key)) = (row.text("id"), row.text("project_key")) {
            map.insert(id.to_string(), key.to_string());
        }
    }
    Ok(map)
}

fn read_claude_records(path: &Path) -> Vec<Json> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| json::parse(line.as_bytes()).ok())
        .collect()
}

// ==== GROK RECORD NORMALIZER ====

struct ToolState {
    id: String,
    name: String,
    input: BTreeMap<String, Json>,
    result: Option<String>,
    is_error: bool,
}

struct GrokTurn {
    user_buf: String,
    user_ts: String,
    asst_text: String,
    asst_think: String,
    asst_ts: String,
    asst_model: String,
    tools: HashMap<String, ToolState>,
    turn_tools: Vec<String>,
    records: Vec<Json>,
}

fn grok_updates_to_records(dir: &Path) -> Vec<Json> {
    let Ok(text) = fs::read_to_string(dir.join("updates.jsonl")) else {
        return Vec::new();
    };
    let mut turn = GrokTurn {
        user_buf: String::new(),
        user_ts: String::new(),
        asst_text: String::new(),
        asst_think: String::new(),
        asst_ts: String::new(),
        asst_model: String::new(),
        tools: HashMap::new(),
        turn_tools: Vec::new(),
        records: Vec::new(),
    };
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = json::parse(line.as_bytes()) else {
            continue;
        };
        let Some(update) = record.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        if update.as_obj().is_none() {
            continue;
        }
        let kind = update.get_str("sessionUpdate").unwrap_or("");
        let meta = record.get("params").and_then(|p| p.get("_meta"));
        let ts = to_iso_js(record.get("timestamp"), meta.and_then(|m| m.get("agentTimestampMs")));
        match kind {
            "user_message_chunk" => {
                turn.flush_asst(None);
                if let Some(text) = update.get("content").and_then(|c| c.get_str("text")) {
                    turn.user_buf.push_str(text);
                }
                if !ts.is_empty() {
                    turn.user_ts = ts;
                }
            }
            "agent_thought_chunk" => {
                turn.flush_user();
                if let Some(text) = update.get("content").and_then(|c| c.get_str("text")) {
                    turn.asst_think.push_str(text);
                }
                if !ts.is_empty() {
                    turn.asst_ts = ts;
                }
            }
            "agent_message_chunk" => {
                turn.flush_user();
                if let Some(text) = update.get("content").and_then(|c| c.get_str("text")) {
                    turn.asst_text.push_str(text);
                }
                if !ts.is_empty() {
                    turn.asst_ts = ts;
                }
                if let Some(model) = update
                    .get("content")
                    .and_then(|c| c.get("_meta"))
                    .and_then(|m| m.get_str("modelId"))
                    .or_else(|| update.get("_meta").and_then(|m| m.get_str("modelId")))
                {
                    if !model.is_empty() {
                        turn.asst_model = model.to_string();
                    }
                }
            }
            "tool_call" => {
                turn.flush_user();
                let id = match update.get_str("toolCallId") {
                    Some(id) if !id.is_empty() => id.to_string(),
                    _ => format!("tool-{}", turn.tools.len()),
                };
                let input = match update.get("rawInput") {
                    Some(Json::Obj(map)) => map.clone(),
                    _ => BTreeMap::new(),
                };
                turn.tools.insert(
                    id.clone(),
                    ToolState {
                        id: id.clone(),
                        name: grok_tool_name(update),
                        input,
                        result: None,
                        is_error: false,
                    },
                );
                if !turn.turn_tools.iter().any(|have| have == &id) {
                    turn.turn_tools.push(id);
                }
                if !ts.is_empty() {
                    turn.asst_ts = ts;
                }
            }
            "tool_call_update" => {
                let Some(id) = update.get_str("toolCallId").filter(|id| !id.is_empty()) else {
                    continue;
                };
                if !turn.tools.contains_key(id) {
                    turn.tools.insert(
                        id.to_string(),
                        ToolState {
                            id: id.to_string(),
                            name: grok_tool_name(update),
                            input: BTreeMap::new(),
                            result: None,
                            is_error: false,
                        },
                    );
                    if !turn.turn_tools.iter().any(|have| have == id) {
                        turn.turn_tools.push(id.to_string());
                    }
                }
                if let Some(tool) = turn.tools.get_mut(id) {
                    if let Some(Json::Obj(map)) = update.get("rawInput") {
                        for (key, value) in map {
                            tool.input.insert(key.clone(), value.clone());
                        }
                    }
                    let has_title = update.get_str("title").is_some_and(|s| !s.is_empty());
                    let has_kind = update.get_str("kind").is_some_and(|s| !s.is_empty());
                    let has_variant = update
                        .get("rawInput")
                        .and_then(|raw| raw.get_str("variant"))
                        .is_some_and(|s| !s.is_empty());
                    if has_title || has_kind || has_variant {
                        tool.name = grok_tool_name(update);
                    }
                    let status = update.get_str("status").unwrap_or("");
                    let raw_present = update.get("rawOutput").is_some_and(|raw| !raw.is_null());
                    if status == "completed" || status == "failed" || raw_present {
                        tool.result = Some(stringify_grok_output(update));
                        tool.is_error = status == "failed";
                    }
                }
                if !ts.is_empty() {
                    turn.asst_ts = ts;
                }
            }
            "turn_completed" => {
                turn.flush_user();
                if turn.asst_model.is_empty() {
                    if let Some(Json::Obj(models)) = update.get("usage").and_then(|u| u.get("modelUsage")) {
                        if let Some(model) = models.keys().next() {
                            turn.asst_model = model.clone();
                        }
                    }
                }
                turn.flush_asst(update.get("usage"));
            }
            _ => {}
        }
    }
    turn.flush_user();
    turn.flush_asst(None);
    turn.records
}

impl GrokTurn {
    fn flush_user(&mut self) {
        if self.user_buf.trim().is_empty() {
            self.user_buf.clear();
            return;
        }
        let mut rec = vec![
            ("type", json::s("user")),
            (
                "message",
                obj([
                    ("role", json::s("user")),
                    ("content", json::s(self.user_buf.clone())),
                ]),
            ),
        ];
        if !self.user_ts.is_empty() {
            rec.push(("timestamp", json::s(self.user_ts.clone())));
        }
        self.records.push(map_obj(rec));
        self.user_buf.clear();
    }

    fn flush_asst(&mut self, usage: Option<&Json>) {
        let has_tools = !self.turn_tools.is_empty();
        let has_text = !self.asst_text.trim().is_empty();
        let has_think = !self.asst_think.trim().is_empty();
        if !has_tools && !has_text && !has_think {
            return;
        }
        let mut content = Vec::new();
        if has_think {
            content.push(obj([
                ("type", json::s("thinking")),
                ("thinking", json::s(self.asst_think.clone())),
            ]));
        }
        if has_text {
            content.push(obj([
                ("type", json::s("text")),
                ("text", json::s(self.asst_text.clone())),
            ]));
        }
        for id in &self.turn_tools {
            let Some(tool) = self.tools.get(id) else {
                continue;
            };
            content.push(obj([
                ("type", json::s("tool_use")),
                ("id", json::s(tool.id.clone())),
                ("name", json::s(tool.name.clone())),
                ("input", Json::Obj(tool.input.clone())),
            ]));
        }
        let mut message = vec![
            ("role", json::s("assistant")),
            ("content", Json::Arr(content)),
        ];
        if !self.asst_model.is_empty() {
            message.push(("model", json::s(self.asst_model.clone())));
        }
        if let Some(usage) = usage {
            if usage.as_obj().is_some() {
                message.push((
                    "usage",
                    obj([
                        ("input_tokens", json::i(num_i64(usage.get("inputTokens")))),
                        ("output_tokens", json::i(num_i64(usage.get("outputTokens")))),
                        (
                            "cache_read_input_tokens",
                            json::i(num_i64(usage.get("cachedReadTokens"))),
                        ),
                        ("cache_creation_input_tokens", json::i(0)),
                    ]),
                ));
            }
        }
        let mut rec = vec![("type", json::s("assistant")), ("message", map_obj(message))];
        if !self.asst_ts.is_empty() {
            rec.push(("timestamp", json::s(self.asst_ts.clone())));
        }
        self.records.push(map_obj(rec));
        let ts = self.asst_ts.clone();
        for id in &self.turn_tools {
            let Some(tool) = self.tools.get(id) else {
                continue;
            };
            let Some(result) = &tool.result else {
                continue;
            };
            let mut record = vec![
                ("type", json::s("user")),
                (
                    "message",
                    obj([
                        ("role", json::s("user")),
                        (
                            "content",
                            Json::Arr(vec![obj([
                                ("type", json::s("tool_result")),
                                ("tool_use_id", json::s(tool.id.clone())),
                                ("content", json::s(result.clone())),
                                ("is_error", Json::Bool(tool.is_error)),
                            ])]),
                        ),
                    ]),
                ),
            ];
            if !ts.is_empty() {
                record.push(("timestamp", json::s(ts.clone())));
            }
            self.records.push(map_obj(record));
        }
        self.asst_text.clear();
        self.asst_think.clear();
        self.asst_ts.clear();
        self.asst_model.clear();
        self.turn_tools.clear();
    }
}

// ==== TEXT, PRICE, PATHS ====

fn content_of(rec: &Json) -> Option<&Json> {
    if let Some(msg) = rec.get("message") {
        if msg.as_obj().is_some() {
            return msg.get("content");
        }
    }
    rec.get("content")
}

fn is_conversational(rec: &Json) -> bool {
    match content_of(rec) {
        Some(Json::Str(text)) => !text.trim().is_empty(),
        Some(Json::Arr(blocks)) => blocks.iter().any(|block| {
            block.get_str("type") == Some("text")
                && block.get_str("text").is_some_and(|text| !text.trim().is_empty())
        }),
        _ => false,
    }
}

fn extract_text(rec: &Json) -> String {
    match content_of(rec) {
        Some(Json::Str(text)) => text.clone(),
        Some(Json::Arr(blocks)) => blocks.iter().map(block_text).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn block_text(block: &Json) -> String {
    if let Some(text) = block.as_str() {
        return text.to_string();
    }
    match block.get_str("type") {
        Some("text") => block.get_str("text").unwrap_or("").to_string(),
        Some("thinking") => block.get_str("thinking").unwrap_or("").to_string(),
        Some("tool_use") => {
            let name = block.get_str("name").unwrap_or("");
            let input = block.get("input").cloned().unwrap_or_else(|| Json::Obj(BTreeMap::new()));
            format!("{name} {}", json::stringify(&input))
        }
        Some("tool_result") => match block.get("content") {
            Some(Json::Str(text)) => text.clone(),
            Some(Json::Arr(parts)) => parts
                .iter()
                .map(|part| part.get_str("text").unwrap_or(""))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

fn grok_tool_name(update: &Json) -> String {
    let variant = update
        .get("rawInput")
        .and_then(|raw| raw.get("variant"))
        .or_else(|| update.get("rawOutput").and_then(|raw| raw.get("variant")));
    if let Some(Json::Str(text)) = variant {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(title) = update.get_str("title") {
        if !title.is_empty() {
            let cut = title
                .split(|c: char| c == ':' || c == '(' || c == '[' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .trim();
            if !cut.is_empty() {
                return cut.to_string();
            }
        }
    }
    if let Some(kind) = update.get_str("kind") {
        if !kind.is_empty() {
            return kind.to_string();
        }
    }
    "tool".into()
}

fn stringify_grok_output(update: &Json) -> String {
    if update.as_obj().is_none() {
        return String::new();
    }
    if let Some(raw) = update.get("rawOutput") {
        if let Some(text) = raw.as_str() {
            return text.to_string();
        }
        if raw.as_obj().is_some() {
            for key in ["EditsApplied", "editsApplied"] {
                if let Some(text) = raw
                    .get(key)
                    .and_then(|applied| applied.get("tool_output_for_prompt"))
                    .and_then(truthy_string)
                {
                    return text;
                }
            }
            if let Some(text) = raw.get("tool_output_for_prompt").and_then(truthy_string) {
                return text;
            }
            if let Some(text) = raw
                .get("tool_output_for_prompt_concise")
                .and_then(truthy_string)
            {
                return text;
            }
            return take_chars(&json::stringify(raw), FTS_BODY_CHARS);
        }
    }
    if let Some(Json::Arr(parts)) = update.get("content") {
        return parts
            .iter()
            .filter_map(|part| {
                let kind = part.get_str("type").unwrap_or("");
                let text = if kind == "text" {
                    part.get_str("text").unwrap_or("").to_string()
                } else if kind == "diff" {
                    [part.get_str("path"), part.get_str("oldText"), part.get_str("newText")]
                        .into_iter()
                        .flatten()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                } else if part.as_obj().is_some() {
                    json::stringify(part)
                } else {
                    String::new()
                };
                if text.is_empty() { None } else { Some(text) }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

fn truthy_string(value: &Json) -> Option<String> {
    match value {
        Json::Str(text) if !text.is_empty() => Some(text.clone()),
        Json::Num(n) if n.is_finite() && *n != 0.0 => Some(json::format_number(*n)),
        Json::Bool(true) => Some("true".into()),
        Json::Obj(_) | Json::Arr(_) => Some("[object Object]".into()),
        _ => None,
    }
}

struct Rates {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

fn price_for(model: &str, prompt_tokens: f64) -> Rates {
    let name = model.to_ascii_lowercase();
    if name.contains("opus") {
        return Rates { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.5 };
    }
    if name.contains("haiku") {
        return Rates { input: 0.8, output: 4.0, cache_write: 1.0, cache_read: 0.08 };
    }
    if name.contains("grok") {
        let (short, long) = grok_rates(&name);
        let tier = if prompt_tokens >= LONG_CONTEXT_TOKENS { long } else { short };
        return Rates { input: tier.0, output: tier.2, cache_write: 0.0, cache_read: tier.1 };
    }
    Rates { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 }
}

fn grok_rates(model: &str) -> ((f64, f64, f64), (f64, f64, f64)) {
    if model.contains("grok-build") {
        return ((1.0, 0.20, 2.0), (2.0, 0.40, 4.0));
    }
    if model.contains("grok-4.3") {
        return ((1.25, 0.20, 2.5), (2.5, 0.40, 5.0));
    }
    if model.contains("grok-4.20") || model.contains("grok-4-20") {
        return ((1.25, 0.20, 2.5), (2.5, 0.40, 5.0));
    }
    ((2.0, 0.30, 6.0), (4.0, 0.60, 12.0))
}

fn cost_of(in_tok: f64, out_tok: f64, cache_create: f64, cache_read: f64, model: &str) -> f64 {
    let promptish = if model.to_ascii_lowercase().contains("grok") {
        in_tok + cache_read
    } else {
        0.0
    };
    let rates = price_for(model, promptish);
    (in_tok * rates.input
        + out_tok * rates.output
        + cache_create * rates.cache_write
        + cache_read * rates.cache_read)
        / 1_000_000.0
}

fn canonical_project(cwd: &str, project: &str) -> (String, String) {
    let trimmed = cwd.trim();
    let mut path = if trimmed.is_empty() { project.to_string() } else { trimmed.to_string() };
    if let Some(cut) = worktree_index(&path) {
        path.truncate(cut);
    }
    let key = path.trim_end_matches(['/', '\\']).to_string();
    let base = base_name(&key);
    let name = if !base.is_empty() {
        base.to_string()
    } else if !key.is_empty() {
        key.clone()
    } else {
        "(unknown)".into()
    };
    (key, name)
}

fn resolve_project(
    id: &str,
    cwd: &str,
    project: &str,
    overrides: &HashMap<String, String>,
) -> (String, String, bool) {
    if let Some(over) = overrides.get(id) {
        let base = base_name(over);
        let name = if base.is_empty() { over.clone() } else { base.to_string() };
        return (over.clone(), name, true);
    }
    let (key, name) = canonical_project(cwd, project);
    (key, name, false)
}

fn worktree_index(path: &str) -> Option<usize> {
    let bytes = path.as_bytes();
    let mut best = None;
    for i in 0..bytes.len() {
        if bytes[i] != b'/' && bytes[i] != b'\\' {
            continue;
        }
        let rest = &path[i + 1..];
        let Some(after_claude) = rest.strip_prefix(".claude") else {
            continue;
        };
        let after = after_claude.as_bytes();
        if after.first().is_none_or(|b| *b != b'/' && *b != b'\\') {
            continue;
        }
        let Some(after_wt) = after_claude[1..].strip_prefix("worktrees") else {
            continue;
        };
        if after_wt.as_bytes().first().is_some_and(|b| *b == b'/' || *b == b'\\') {
            best = Some(i);
            break;
        }
    }
    if let Some(at) = path.find("--claude-worktrees-") {
        best = Some(best.map(|found| found.min(at)).unwrap_or(at));
    }
    best
}

fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn decode_grok_cwd(encoded: &str, group_dir: &Path) -> String {
    if let Ok(text) = fs::read_to_string(group_dir.join(".cwd")) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    decode_uri_component(encoded)
}

fn decode_uri_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return input.to_string();
            }
            let Some(hi) = hex_val(bytes[i + 1]) else {
                return input.to_string();
            };
            let Some(lo) = hex_val(bytes[i + 2]) else {
                return input.to_string();
            };
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn strip_cmd_tags(input: &str) -> String {
    collapse_ws(&strip_lone_tags(&strip_paired_tags(input)))
}

fn strip_paired_tags(input: &str) -> String {
    let mut rest = input.to_string();
    let mut from = 0;
    let mut guard = 0;
    while guard < 10_000 {
        guard += 1;
        let Some((start, end, name)) = find_open_tag(&rest, from, false) else {
            break;
        };
        // An opener with no closer must not hide a later pair. The lone-tag
        // pass removes that opener; keep scanning after it.
        let Some(close_at) = find_close(&rest, end, &name) else {
            from = end;
            continue;
        };
        let close_end = close_at + name.len() + 3;
        rest.replace_range(start..close_end, "");
        from = start;
    }
    rest
}

fn find_close(input: &str, from: usize, name: &str) -> Option<usize> {
    let lower = input.to_ascii_lowercase();
    let needle = format!("</{}>", name.to_ascii_lowercase());
    lower.get(from..)?.find(&needle).map(|index| from + index)
}

fn strip_lone_tags(input: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < input.len() {
        if input.as_bytes()[i] == b'<' {
            if let Some((_, end, _)) = find_open_tag(input, i, true) {
                if end > i {
                    i = end;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Find a command tag at or after `from`.
///
/// `allow_close` accepts `</name>`. The returned end index is one past `>`.
fn find_open_tag(input: &str, from: usize, allow_close: bool) -> Option<(usize, usize, String)> {
    let bytes = input.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i + 1;
        let closing = j < bytes.len() && bytes[j] == b'/';
        if closing {
            if !allow_close {
                i += 1;
                continue;
            }
            j += 1;
        }
        let name_start = j;
        while j < bytes.len() && (bytes[j].is_ascii_alphabetic() || bytes[j] == b'-') {
            j += 1;
        }
        if j == name_start {
            i += 1;
            continue;
        }
        let name = input[name_start..j].to_string();
        if !is_command_tag(&name) {
            i += 1;
            continue;
        }
        let next = bytes.get(j).copied();
        let last = bytes[j - 1];
        if !word_boundary(last, next) {
            i += 1;
            continue;
        }
        while j < bytes.len() && bytes[j] != b'>' {
            j += 1;
        }
        if j >= bytes.len() {
            return None;
        }
        return Some((start, j + 1, name));
    }
    None
}

fn is_command_tag(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("local-command-") {
        rest
    } else if let Some(rest) = lower.strip_prefix("command-") {
        rest
    } else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

fn word_boundary(left: u8, right: Option<u8>) -> bool {
    let left_word = left.is_ascii_alphanumeric() || left == b'_';
    let right_word = right.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_');
    left_word != right_word
}

fn collapse_ws(input: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            pending = !out.is_empty();
            continue;
        }
        if pending {
            out.push(' ');
            pending = false;
        }
        out.push(ch);
    }
    out
}

fn fts_match(q: &str) -> String {
    q.split_whitespace()
        .map(|token| {
            let clean: String = token.chars().filter(|ch| *ch != '"').collect();
            format!("\"{clean}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn js_slice_end(len: usize, limit: i64) -> usize {
    if limit < 0 {
        (len as i64 + limit).max(0) as usize
    } else {
        (limit as u64).min(len as u64) as usize
    }
}

fn take_chars(input: &str, max: usize) -> String {
    input.chars().take(max).collect()
}

fn push_unique(models: &mut Vec<String>, model: &str) {
    if !model.is_empty() && !models.iter().any(|have| have == model) {
        models.push(model.to_string());
    }
}

fn json_id(value: Option<&Json>) -> Option<String> {
    match value {
        Some(Json::Str(text)) if !text.is_empty() => Some(text.clone()),
        Some(Json::Num(n)) if n.is_finite() => Some(json::format_number(*n)),
        _ => None,
    }
}

fn present_ts(value: Option<&Json>) -> Option<String> {
    match value {
        Some(Json::Str(text)) if !text.is_empty() => Some(text.clone()),
        Some(Json::Num(n)) if n.is_finite() && *n != 0.0 => Some(json::format_number(*n)),
        _ => None,
    }
}

fn num_i64(value: Option<&Json>) -> i64 {
    match value {
        Some(Json::Num(n)) if n.is_finite() => *n as i64,
        _ => 0,
    }
}

fn cell_text(row: &Row, col: &str) -> String {
    row.text(col).unwrap_or("").to_string()
}

fn cell_i64(row: &Row, col: &str) -> i64 {
    match row.get(col) {
        Some(Value::Int(v)) => *v,
        Some(Value::Real(v)) => *v as i64,
        _ => 0,
    }
}

fn cell_f64(row: &Row, col: &str) -> Option<f64> {
    match row.get(col) {
        Some(Value::Real(v)) => Some(*v),
        Some(Value::Int(v)) => Some(*v as f64),
        _ => None,
    }
}

fn sql_num(row: &Row, col: &str) -> Json {
    match row.get(col) {
        Some(Value::Int(v)) => json::i(*v),
        Some(Value::Real(v)) => Json::Num(*v),
        _ => Json::Null,
    }
}

fn source_or_claude(row: &Row) -> String {
    match row.text("source") {
        Some(source) if !source.is_empty() => source.to_string(),
        _ => "claude".into(),
    }
}

fn to_iso_value(value: Option<&Json>) -> String {
    to_iso_js(value, None)
}

fn to_iso_js(ts: Option<&Json>, ms: Option<&Json>) -> String {
    if let Some(Json::Num(n)) = ms {
        if n.is_finite() {
            return iso_from_unix_ms(n.round() as i64);
        }
    }
    if let Some(Json::Num(n)) = ts {
        if n.is_finite() {
            let millis = if *n < 1e12 { *n * 1000.0 } else { *n };
            return iso_from_unix_ms(millis.round() as i64);
        }
    }
    if let Some(Json::Str(text)) = ts {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            if let Some(millis) = parse_iso_ms(trimmed) {
                return iso_from_unix_ms(millis);
            }
            return text.clone();
        }
    }
    String::new()
}

fn iso_from_unix_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    (year as i32, month as u32, day as u32)
}

fn parse_iso_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year = parse_n(bytes, 0, 4)?;
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let month = parse_n(bytes, 5, 2)?;
    let day = parse_n(bytes, 8, 2)?;
    let mut i = 10;
    let mut hour = 0i64;
    let mut minute = 0i64;
    let mut second = 0i64;
    let mut millis = 0i64;
    if i < bytes.len() && (bytes[i] == b'T' || bytes[i] == b' ') {
        i += 1;
        hour = parse_n(bytes, i, 2)?;
        i += 2;
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        minute = parse_n(bytes, i, 2)?;
        i += 2;
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        second = parse_n(bytes, i, 2)?;
        i += 2;
        if i < bytes.len() && bytes[i] == b'.' {
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if start == i {
                return None;
            }
            millis = frac_to_millis(&bytes[start..i]);
        }
    }
    let mut offset = 0i64;
    if i < bytes.len() {
        if bytes[i] == b'Z' || bytes[i] == b'z' {
            i += 1;
        } else if bytes[i] == b'+' || bytes[i] == b'-' {
            let sign = if bytes[i] == b'-' { -1 } else { 1 };
            i += 1;
            let oh = parse_n(bytes, i, 2)?;
            i += 2;
            let om = if bytes.get(i) == Some(&b':') {
                i += 1;
                let value = parse_n(bytes, i, 2)?;
                i += 2;
                value
            } else if i + 1 < bytes.len() && bytes[i].is_ascii_digit() {
                let value = parse_n(bytes, i, 2)?;
                i += 2;
                value
            } else {
                0
            };
            offset = sign * (oh * 3600 + om * 60) * 1000;
        } else {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + millis - offset)
}

fn parse_n(bytes: &[u8], at: usize, len: usize) -> Option<i64> {
    if at + len > bytes.len() {
        return None;
    }
    let mut n = 0i64;
    for byte in &bytes[at..at + len] {
        if !byte.is_ascii_digit() {
            return None;
        }
        n = n * 10 + i64::from(byte - b'0');
    }
    Some(n)
}

fn frac_to_millis(frac: &[u8]) -> i64 {
    let mut millis = 0i64;
    let mut place = 100i64;
    for byte in frac.iter().take(3) {
        millis += i64::from(byte - b'0') * place;
        place /= 10;
    }
    if frac.len() > 3 && frac[3] >= b'5' {
        millis += 1;
    }
    millis
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = (year - era * 400) as u64;
    let mp = (if month > 2 { month - 3 } else { month + 9 }) as u64;
    let doy = (153 * mp + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe as i64 - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(n: f64) -> Json {
        Json::Num(n)
    }

    #[test]
    fn epoch_round_trips() {
        assert_eq!(iso_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(to_iso_js(Some(&num(0.0)), None), "1970-01-01T00:00:00.000Z");
        assert_eq!(to_iso_js(Some(&num(1.0)), Some(&num(0.0))), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn price_and_cost_match_the_node_indexer() {
        assert_eq!(price_for("claude-opus-4-8", 0.0).input, 15.0);
        assert_eq!(price_for("claude-3-5-haiku", 0.0).output, 4.0);
        let unknown = price_for("whatever-unknown", 0.0);
        assert_eq!(unknown.input, 3.0);
        assert_eq!(unknown.output, 15.0);
        assert_eq!(unknown.cache_write, 3.75);
        assert_eq!(unknown.cache_read, 0.3);
        assert_eq!(price_for("grok-4.5", 0.0).input, 2.0);
        assert_eq!(price_for("grok-4.5", 0.0).cache_read, 0.3);
        assert_eq!(price_for("grok-4.5", 0.0).output, 6.0);
        assert_eq!(price_for("grok-build", 0.0).input, 1.0);
        assert_eq!(price_for("grok-build", 0.0).output, 2.0);
        assert_eq!(price_for("grok-4.5", 200_000.0).input, 4.0);
        assert_eq!(price_for("grok-4.5", 200_000.0).output, 12.0);
        assert_eq!(cost_of(1_000_000.0, 0.0, 0.0, 0.0, "claude-opus-4-8"), 15.0);
        assert_eq!(cost_of(0.0, 1_000_000.0, 0.0, 0.0, "claude-sonnet-4-6"), 15.0);
    }

    #[test]
    fn canonical_project_folds_worktrees() {
        let (key, name) = canonical_project("/Users/dev/projects/session-review", "");
        assert_eq!(key, "/Users/dev/projects/session-review");
        assert_eq!(name, "session-review");
        let (key, name) = canonical_project(
            "/Users/dev/projects/demo-app/.claude/worktrees/crazy-johnson-a99b2c",
            "",
        );
        assert_eq!(key, "/Users/dev/projects/demo-app");
        assert_eq!(name, "demo-app");
        let (_, name) = canonical_project(
            "",
            "-Users-dev-projects-demo-app--claude-worktrees-crazy-johnson-a99b2c",
        );
        assert_eq!(name, "-Users-dev-projects-demo-app");
        assert_eq!(
            canonical_project("/Users/dev/projects/demo-app", "-Users-dev-projects-demo-app").1,
            "demo-app"
        );
        assert_eq!(canonical_project("/Users/dev/projects/demo-app/", "").1, "demo-app");
    }

    #[test]
    fn conversational_and_extract_text() {
        let hello = json::parse(br#"{"message":{"role":"user","content":"hello"}}"#).unwrap();
        assert_eq!(extract_text(&hello), "hello");
        assert!(is_conversational(&json::parse(br#"{"type":"user","message":{"content":"hello there"}}"#).unwrap()));
        let blocks = json::parse(
            br#"{"message":{"content":[{"type":"text","text":"A"},{"type":"thinking","thinking":"B"},{"type":"tool_use","name":"Bash","input":{"cmd":"ls"}},{"type":"tool_result"}]}}"#,
        )
        .unwrap();
        let text = extract_text(&blocks);
        assert!(text.contains('A'));
        assert!(text.contains('B'));
        assert!(text.contains("Bash"));
        assert!(is_conversational(&json::parse(br#"{"message":{"content":[{"type":"text","text":"sure"}]}}"#).unwrap()));
        assert!(!is_conversational(
            &json::parse(br#"{"message":{"content":[{"type":"tool_result","content":"ok"}]}}"#).unwrap()
        ));
        assert!(!is_conversational(
            &json::parse(br#"{"message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#).unwrap()
        ));
        assert!(!is_conversational(
            &json::parse(br#"{"message":{"content":[{"type":"text","text":"   "}]}}"#).unwrap()
        ));
    }

    #[test]
    fn overrides_and_tool_names() {
        let mut overrides = HashMap::new();
        overrides.insert("abc".into(), "/Users/dev/projects/other-app".into());
        let (key, name, over) = resolve_project("abc", "/Users/dev/projects", "", &overrides);
        assert_eq!(key, "/Users/dev/projects/other-app");
        assert_eq!(name, "other-app");
        assert!(over);
        let (_, name, over) = resolve_project("xyz", "/Users/dev/projects/demo-app", "", &HashMap::new());
        assert_eq!(name, "demo-app");
        assert!(!over);
        let tool = json::parse(br#"{"title":"Write","rawInput":{"variant":"CursorWrite"}}"#).unwrap();
        assert_eq!(grok_tool_name(&tool), "CursorWrite");
        let edit = json::parse(br#"{"title":"Edit `/tmp/x`"}"#).unwrap();
        assert_eq!(grok_tool_name(&edit), "Edit");
        let output = json::parse(br#"{"rawOutput":{"EditsApplied":{"tool_output_for_prompt":"Wrote file"}}}"#).unwrap();
        assert_eq!(stringify_grok_output(&output), "Wrote file");
        let dir = std::env::temp_dir();
        assert_eq!(decode_grok_cwd("%2FUsers%2Fdev%2Fprojects", &dir), "/Users/dev/projects");
        assert_eq!(strip_cmd_tags("<command-name>foo</command-name> hello"), "hello");
        assert_eq!(
            strip_cmd_tags("<command-message>foo is running</command-message> <command-name>/foo</command-name> <command-args>bar</command-args> actual content"),
            "actual content"
        );
        assert_eq!(
            strip_cmd_tags("<command-name>unclosed <local-command-caveat>secret</local-command-caveat> hello"),
            "unclosed hello"
        );
        assert_eq!(strip_cmd_tags("hi <command-name> there"), "hi there");
        assert_eq!(strip_cmd_tags("just normal text"), "just normal text");
    }

    #[test]
    fn grok_updates_normalize_to_claude_shape() {
        let dir = std::env::temp_dir().join(format!("sr-grok-{}-norm", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let lines = [
            r#"{"timestamp":1000,"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello"}},"_meta":{"agentTimestampMs":1000000}}}"#,
            r#"{"timestamp":1001,"params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking…"}}}}"#,
            r#"{"timestamp":1002,"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Read","rawInput":{"path":"/tmp/a"}}}}"#,
            r#"{"timestamp":1003,"params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","rawOutput":{"tool_output_for_prompt":"file body"}}}}"#,
            r#"{"timestamp":1004,"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}"#,
            r#"{"timestamp":1005,"params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":100,"outputTokens":10,"cachedReadTokens":40,"modelUsage":{"grok-4.5":{}}}}}}"#,
        ];
        fs::write(dir.join("updates.jsonl"), lines.join("\n")).unwrap();
        let records = grok_updates_to_records(&dir);
        assert_eq!(records[0].get_str("type"), Some("user"));
        assert_eq!(records[0].get("message").and_then(|m| m.get_str("content")), Some("hello"));
        assert_eq!(records[1].get_str("type"), Some("assistant"));
        let blocks = records[1].get("message").and_then(|m| m.get("content")).and_then(|c| c.as_arr()).unwrap();
        assert!(blocks.iter().any(|b| b.get_str("type") == Some("thinking") && b.get_str("thinking").unwrap_or("").contains("thinking")));
        assert!(blocks.iter().any(|b| b.get_str("type") == Some("text") && b.get_str("text") == Some("done")));
        assert!(blocks.iter().any(|b| b.get_str("type") == Some("tool_use") && b.get_str("id") == Some("t1")));
        assert_eq!(records[1].get("message").and_then(|m| m.get_str("model")), Some("grok-4.5"));
        assert_eq!(records[2].get_str("type"), Some("user"));
        let result = records[2].get("message").and_then(|m| m.get("content")).and_then(|c| c.as_arr()).unwrap();
        assert_eq!(result[0].get_str("type"), Some("tool_result"));
        assert_eq!(result[0].get_str("content"), Some("file body"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_round_trip_searches_claude_and_grok() {
        let root = std::env::temp_dir().join(format!("sr-cc-{}-idx", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let claude = root.join("claude");
        let grok = root.join("grok");
        fs::create_dir_all(claude.join("proj")).unwrap();
        fs::create_dir_all(grok.join("group").join("sid")).unwrap();
        fs::write(
            claude.join("proj").join("abc.jsonl"),
            "{\"type\":\"user\",\"timestamp\":\"1970-01-01T00:00:00.000Z\",\"cwd\":\"/tmp/demo-app\",\"message\":{\"role\":\"user\",\"content\":\"hello zebra\"}}\n",
        )
        .unwrap();
        fs::write(
            grok.join("group").join("sid").join("updates.jsonl"),
            "{\"timestamp\":1,\"params\":{\"update\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"text\":\"grok needle\"}}}}\n{\"timestamp\":2,\"params\":{\"update\":{\"sessionUpdate\":\"turn_completed\",\"usage\":{\"inputTokens\":10,\"outputTokens\":1,\"cachedReadTokens\":0,\"modelUsage\":{\"grok-4.5\":{}}}}}}\n",
        )
        .unwrap();
        let index = SessionIndex::open_with(
            &root.join("ccindex.db"),
            Roots { claude_dir: claude, grok_sessions: grok },
        )
        .unwrap();
        let before = index.sessions(None).unwrap();
        assert_eq!(before.as_arr().unwrap().len(), 0);
        let refreshed = index.reindex(true).unwrap();
        assert_eq!(refreshed.get("files").and_then(|v| v.as_i64()), Some(2));
        let sessions = index.sessions(None).unwrap();
        assert_eq!(sessions.as_arr().unwrap().len(), 2);
        let zebra = index.search("zebra", None, 10).unwrap();
        assert!(zebra.as_arr().unwrap().iter().any(|row| row.get_str("snippet").unwrap_or("").contains("zebra")));
        let detail = index.session("abc").unwrap().unwrap();
        assert_eq!(detail.get("meta").and_then(|m| m.get_str("project_name")), Some("demo-app"));
        assert!(!detail.get("records").and_then(|r| r.as_arr()).unwrap().is_empty());
        index.close();
        let _ = fs::remove_dir_all(&root);
    }
}
