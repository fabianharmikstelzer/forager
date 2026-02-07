![Forager — semantic search across all your Claude Code sessions](banner.jpeg)

# session-forager

Forage through your Claude Code session history with semantic search. Find any past conversation.

## Install

```bash
npm install -g session-forager
```

## Quick Start

```bash
forager index            # Index all sessions (first run downloads ~22MB embedding model)
forager setup            # Auto-index daily (launchd on macOS, cron on Linux)
```

### Teach Claude Code about Forager

Add this to your `~/.claude/CLAUDE.md` so Claude can search your history automatically:

```markdown
## Forager — Session Search

You have `forager` installed — a semantic search tool for your Claude Code session history.

When the user asks about past sessions, previous work, or "that time I worked on X":
1. Run `forager search "query"` via Bash to find relevant sessions
2. Show the results to the user
3. If they want to resume one, tell them the `claude --resume <id>` command to run
```

## Usage

```bash
forager search "that auth bug I fixed"
```

```
 1. [0.87] Implementing OAuth2 login flow (Jan 22)
    Project: ~/myproject  Branch: feature/auth
    Resume: claude --resume e75b8241

 2. [0.71] Sandbox Mode Setup Explained (Dec 27)
    Project: ~
    Resume: claude --resume b4905ee8
```

Copy the `claude --resume` command and run it in a new terminal to pick up where you left off.

### All Commands

| Command | Description |
|---------|-------------|
| `forager index` | Index all sessions (incremental — skips unchanged) |
| `forager index --full` | Re-index everything from scratch |
| `forager search "query"` | Semantic search across all sessions |
| `forager search "query" -n 10` | Return more results |
| `forager stats` | Show index statistics |
| `forager setup` | Install daily auto-indexing |
| `forager teardown` | Remove daily auto-indexing |

## What Gets Indexed

Forager scans three sources, so nothing gets missed:

1. **Session indexes** (`~/.claude/projects/*/sessions-index.json`) — sessions with summaries and metadata
2. **Orphaned JSONL files** — session transcripts without an index entry
3. **Prompt history** (`~/.claude/history.jsonl`) — every prompt ever typed, grouped into sessions

Each session is embedded locally using [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (384-dim vectors, runs via ONNX in Node.js). Embeddings and metadata are stored in a local SQLite database at `~/.claude/session-memory.db`.

## How It Works

- Embeddings run 100% locally via `@huggingface/transformers` — no API keys, no network calls after first model download
- Incremental indexing: only processes new or modified sessions
- `forager setup` installs a **launchd agent** on macOS (no permission prompts, catches up after sleep) or a **cron job** on Linux
- Search uses cosine similarity against all stored embeddings

## Requirements

- Node.js 18+
- Claude Code (the session data it generates)
