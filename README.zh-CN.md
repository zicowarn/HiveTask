# HiveTask

[English](./README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-blue)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()

HiveTask（谐音 "Have a task"）是一个跨平台桌面工作台，用于围绕本地仓库
管理 GitHub Issue。它通过已完成认证的 [`gh`](https://cli.github.com) CLI 与
GitHub 通信，并把数据缓存到仓库旁的 SQLite 数据库中，离线也可查看。

## 功能特性

- **以仓库为中心**：选择任意本地 Git 文件夹即可，仓库归属由 git remote
  自动解析；最近使用的仓库会被记住。
- **Issue 工作台**：按 Open / Closed / All 浏览，列表—详情双栏展示标签、
  负责人、作者与日期。
- **可调分栏**：工作台基于可拖拽、可嵌套的分栏布局。
- **本地优先缓存**：拉取的数据通过版本化迁移写入
  `<repo>/.hivetask/hivetask.db`（SQLite），无网络时仍可读取。
- **一键跳转**：从任意 Issue 直接在浏览器打开对应 GitHub 页面。
- **原生桌面**：基于 Tauri 打包，支持 macOS、Windows 与 Linux。

## 技术栈

| 层 | 选型 |
|------|------|
| 桌面壳 | Tauri 2（Rust 后端 + 系统 WebView） |
| 前端 | Vue 3（`<script setup>`）· TypeScript · Pinia · Vite |
| 本地核心 | Rust：`gh` 子进程封装、serde_json 解析、rusqlite |
| 缓存 | 仓库级 SQLite，配合版本化 schema 迁移 |

数据核心放在 Rust 而非前端，便于以后在桌面壳之外复用同一套核心代码。

## 架构

```
┌─────────────────────────────────────────────┐
│  Vue 工作台（src/）                           │
│  顶栏 · SplitPane 分栏 · 面板 · Pinia        │
├─────────────────────────────────────────────┤
│  Tauri commands（src-tauri/src/lib.rs）       │
├─────────────────────────────────────────────┤
│  Rust 核心                                    │
│  gh.rs（CLI 调用 / JSON 解析）                │
│  storage.rs（rusqlite + schema 迁移）         │
├─────────────────────────────────────────────┤
│  gh CLI · <repo>/.hivetask/hivetask.db       │
└─────────────────────────────────────────────┘
```

## 快速开始

### 前置条件

- Node.js 20+、pnpm 10+
- Rust stable 工具链
- Tauri 2 平台依赖（Linux 需 webkit2gtk）
- [`gh`](https://cli.github.com) CLI，并已执行 `gh auth login`

```bash
pnpm install
pnpm tauri dev      # 开发模式（Vite HMR + Rust 热重载）
```

开发模式下可用环境变量在启动时预加载一个仓库；该变量不会进入打包产物：

```bash
VITE_AUTO_REPO=/path/to/repo pnpm tauri dev
```

### 测试与构建

```bash
# Rust 单元测试（gh JSON 解析、SQLite 迁移、缓存刷新）
cd src-tauri && cargo test

# 前端类型检查与生产构建
pnpm build

# 桌面分发包
pnpm tauri build
```

## 项目结构

```
HiveTask/
├── src/                     # Vue 前端
│   ├── workbench/           #   SplitPane 分栏布局原语
│   ├── panels/              #   Issue 列表与详情面板
│   ├── stores/              #   Pinia store（仓库、Issue）
│   ├── api.ts               #   Tauri command 的类型化封装
│   └── types.ts
├── src-tauri/src/
│   ├── lib.rs               # Tauri command 接口层
│   ├── gh.rs                # gh CLI 调用与 JSON 解析
│   ├── storage.rs           # SQLite 迁移与缓存
│   ├── models.rs            # 共享数据模型
│   └── migrations/          # 版本化 SQL 迁移
├── index.html
└── package.json
```

## 许可证

[MIT](./LICENSE) © 2026 Barbossa
