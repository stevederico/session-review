<div align="center">
  <h1>CC Review</h1>
  <h3>browse, search, and analyze your claude code conversations — local, read-only, react + hono + sqlite</h3>
</div>

<br />

Claude Code stores every session as a JSONL transcript under `~/.claude/projects` — local files that never sync to Claude Desktop or claude.ai, so there's no UI to read them. CC Review is that UI: it indexes your transcripts into SQLite and serves a fast browser for reading, full-text search, and usage/cost analytics. Everything stays on your machine.

<br />

## 🚀 Quick Start

```bash
npm run install-all
npm run start
```

Frontend: http://localhost:5173 — Backend: http://localhost:8000

The backend reads `~/.claude/projects` directly and builds its index on first request (incremental by file mtime thereafter). Use **Refresh** in the Browse view to force a re-scan.

<br />

## ✨ Features

### 📂 **Browse**
- **Master/detail viewer** — pick a project, pick a session, read the full transcript
- **Full-fidelity rendering** — user prompts, assistant markdown, and collapsible **Thinking** and **tool-call** blocks
- **Per-session metadata** — model, git branch, message count, estimated cost

### 🔎 **Search**
- **SQLite FTS5 full-text search** across every session
- **Highlighted matches** in context snippets, filterable by project
- **Jump straight into** the matching conversation

### 📊 **Analytics**
- **Totals** — sessions, messages, tokens, estimated cost
- **By model** and **top projects** breakdowns
- **Activity** over the last 60 days

<br />

## 🧱 Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| **React** | 19 | Frontend UI |
| **Vite** | 8 | Build / dev server |
| **Hono** | 4 | Backend HTTP server (Node) |
| **node:sqlite** | built-in | Index + FTS5 full-text search |
| **Tailwind CSS** | 4 | Styling (semantic tokens) |
| **skateboard-ui** | 3.8 | Application shell + shadcn components |

<br />

## 🏗️ Architecture

The backend indexer (`backend/cc-index.js`) walks `~/.claude/projects`, parses each JSONL transcript, and upserts session metadata + an FTS5 table into a local SQLite cache. Full transcripts are read fresh from disk on demand so rendering keeps full fidelity. The frontend is a [Skateboard](https://github.com/stevederico/skateboard) shell with three routes (Browse, Search, Analytics) talking to read-only `/api/cc/*` endpoints.

```
~/.claude/projects/*.jsonl  →  SQLite (FTS5)  →  Hono /api/cc/*  →  React UI
```

<br />

## 🧪 Tests

```bash
npm test
```

Runs Node's built-in test runner against the indexer helpers and formatters.

<br />

## 📄 License

[MIT License](LICENSE)

<br />

<div align="center">
  Made with <a href="https://github.com/stevederico/skateboard">Skateboard</a> — a React boilerplate with auth and payments
</div>
