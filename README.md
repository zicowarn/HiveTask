# HiveTask

**English** · [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-blue)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()

HiveTask — *"Have a task"* — is a cross-platform desktop workbench for
managing GitHub issues from a local repository. It talks to GitHub through the
authenticated [`gh`](https://cli.github.com) CLI and caches everything in a
SQLite database next to the repository, so your data stays available offline.

## Features

- **Repository-centric** — point HiveTask at any local Git folder; the
  repository is resolved from its git remotes. Recent repositories are
  remembered.
- **Issue workbench** — browse issues by Open / Closed / All, with labels,
  assignees, authors, and dates in a list–detail layout.
- **Resizable panes** — the workbench is built on a draggable, nestable
  split-pane layout.
- **Local-first cache** — fetched data is stored in
  `<repo>/.hivetask/hivetask.db` (SQLite) via versioned migrations and can be
  read without any network access.
- **Open on GitHub** — jump from any issue straight to its page in the
  browser.
- **Native desktop** — packaged with Tauri for macOS, Windows, and Linux.

## Tech Stack

| Layer | Choice |
|------|------|
| Desktop shell | Tauri 2 (Rust backend, system WebView) |
| Frontend | Vue 3 (`<script setup>`) · TypeScript · Pinia · Vite |
| Local core | Rust: `gh` subprocess wrapper, serde_json parsing, rusqlite |
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
│  gh.rs (CLI calls / JSON parsing)            │
│  storage.rs (rusqlite + schema migrations)   │
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
│   ├── panels/              #   Issue list and detail panels
│   ├── stores/              #   Pinia stores (repository, issues)
│   ├── api.ts               #   Typed Tauri command bindings
│   └── types.ts
├── src-tauri/src/
│   ├── lib.rs               # Tauri command surface
│   ├── gh.rs                # gh CLI invocation and JSON parsing
│   ├── storage.rs           # SQLite migrations and cache
│   ├── models.rs            # Shared data models
│   └── migrations/          # Versioned SQL migrations
├── index.html
└── package.json
```

## License

[MIT](./LICENSE) © 2026 Barbossa
