<div align="center">
  <h1>Session Review</h1>
  <h3>your coding-agent sessions, local — react + hono + sqlite</h3>
</div>

<br />

Coding agents store every session as local transcripts — claude under `~/.claude/projects`, grok under `~/.grok/sessions`. Session Review indexes them into SQLite and serves a fast browser for reading, full-text search, and usage/cost analytics. Everything stays on your machine.

<br />

## 🚀 Quick Start

```bash
npm run install-all
npm run start
```

Frontend: http://localhost:5173 — Backend: http://localhost:8000

The backend scans both agent homes on first request (incremental by mtime thereafter). Use **Refresh** under Settings to force a re-scan.

<br />

## ✨ Features

### 📂 **Browse**
- **Sidebar conversations** — filter/sort sessions in the shell sidebar; transcript opens in the main pane
- **Mode picker** — Browse / Analytics switch where the logo sits
- **Multi-source** — claude and grok sessions in one list (source badge + matching resume command)
- **Full-fidelity rendering** — user prompts, assistant markdown, collapsible thinking and tool-call blocks
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
| **skateboard-ui** | 4.x | Application shell + shadcn components |

<br />

## 🏗️ Architecture

The backend indexer (`backend/cc-index.js`) walks coding-agent session stores (claude + grok), parses each transcript, and upserts session metadata + an FTS5 table into a local SQLite cache. Grok `updates.jsonl` streams are normalized into the same record shape as claude JSONL so the UI has one renderer. Full transcripts are read fresh from disk on demand.

```
~/.claude/projects/*.jsonl  ─┐
                             ├→ SQLite (FTS5) → Hono /api/cc/* → React UI
~/.grok/sessions/<cwd>/<id>/ ┘
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
