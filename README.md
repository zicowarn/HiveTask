# HiveTask

**English** · [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-blue)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()

HiveTask — *"Have a task"* — is a cross-platform desktop workbench for
managing issues and pull requests around a local Git repository. It talks to
GitHub through the authenticated [`gh`](https://cli.github.com) CLI and caches
everything in a SQLite database next to the repository, so your data stays
available offline.

The product direction is a **multi-source repository workbench**: on top of
one shared data model and cache, it will progressively gain self-hosted
Gitea/GitLab (LAN teams) and purely local repositories (no remote), plus
Projects-style boards over the unified model. See "Roadmap" below.

## Features

- **Repository-centric** — point HiveTask at any local Git folder; the
  repository is resolved from its git remotes. Recent repositories are
  remembered.
- **Issue & PR workbench** — browse by state (issues: Open / Closed / All;
  pulls: Open / Closed / Merged) in a list–detail layout with labels,
  milestones, assignees, authors, and dates.
- **Write actions (write-through)** — comment, close / reopen, and merge
  (merge / squash / rebase), with optimistic updates, rollback on failure,
  and localized error toasts.
- **Tools workspace** — a git history lane graph (branch bars, ahead/behind,
  manual fetch) and an integrated terminal (xterm.js + PTY, selectable shell).
- **Resizable panes** — the workbench is built on a draggable, nestable
  split-pane layout with persisted layouts.
- **Local-first cache** — fetched data is stored in
  `<repo>/.hivetask/hivetask.db` (SQLite) via versioned migrations and can be
  read without any network access.
- **Open on GitHub** — jump from any issue or pull request straight to its
  page in the browser.
- **Native desktop** — packaged with Tauri for macOS, Windows, and Linux;
  dark / light / system themes, English & Chinese localization, native app
  menus, and a status bar.

## Roadmap

| Stage | Scope |
|-------|-------|
| Now | GitHub issue / PR read-write workbench (via gh CLI) |
| Next | `Source` trait abstraction → Gitea integration (LAN teams) → local issues (no-remote repos out of the box) |
| Later | Projects-style boards: Board / Table views over the unified issue model, aggregated across sources |
| Eventually | bundled gh sidecar, OAuth Device Flow GUI, sync-interval preferences |

PR review (diffs, inline comments, approvals, CI checks) is deliberately not
re-implemented on the desktop — it always opens in the browser.

## Tech Stack

| Layer | Choice |
|------|------|
| Desktop shell | Tauri 2 (Rust backend, system WebView) |
| Frontend | Vue 3 (`<script setup>`) · TypeScript · Pinia · Vite |
| Local core | Rust: `gh` subprocess wrapper (GitHub source), git2-rs (history & branches), portable-pty (terminal), serde_json parsing, rusqlite |
| Cache | Per-repository SQLite with versioned schema migrations |

The data core lives in Rust rather than the frontend so it can be reused
outside the desktop shell later.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Vue workbench (src/)                        │
│  App header · SplitPane · panels · Pinia     │
├─────────────────────────────────────────────┤
│  Tauri commands (src-tauri/src/lib.rs)       │
├─────────────────────────────────────────────┤
│  Rust core                                   │
│  gh.rs (GitHub source: CLI calls / JSON)     │
│  git.rs (git2-rs history & branches)         │
│  pty.rs (terminal) · storage.rs (rusqlite)   │
├─────────────────────────────────────────────┤
│  gh CLI · <repo>/.hivetask/hivetask.db       │
└─────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+ and pnpm 10+
- Rust stable toolchain
- Tauri 2 platform dependencies (Linux requires webkit2gtk)
- The [`gh`](https://cli.github.com) CLI, authenticated via `gh auth login`

```bash
pnpm install
pnpm tauri dev      # development mode with Vite HMR + Rust reload
```

A development-only environment variable can preload a repository at startup;
it is never embedded in packaged builds:

```bash
VITE_AUTO_REPO=/path/to/repo pnpm tauri dev
```

### Test and Build

```bash
# Rust unit tests (gh JSON parsing, SQLite migrations, cache refresh)
cd src-tauri && cargo test

# Frontend type-check and production bundle
pnpm build

# Desktop distribution packages
pnpm tauri build
```

## Project Structure

```
HiveTask/
├── src/                     # Vue frontend
│   ├── workbench/           #   SplitPane layout primitives
│   ├── panels/              #   Issue / PR list and detail panels
│   ├── stores/              #   Pinia stores (repo, issues/PRs, sync, settings)
│   ├── api.ts               #   Typed Tauri command bindings
│   └── types.ts
├── src-tauri/src/
│   ├── lib.rs               # Tauri command surface
│   ├── gh.rs                # GitHub source (gh CLI invocation and JSON parsing)
│   ├── git.rs               # git2-rs commit history and branches
│   ├── pty.rs               # Integrated terminal PTY
│   ├── storage.rs           # SQLite migrations and cache
│   ├── models.rs            # Shared data models
│   └── migrations/          # Versioned SQL migrations
├── index.html
└── package.json
```

## License

[MIT](./LICENSE) © 2026 Barbossa
