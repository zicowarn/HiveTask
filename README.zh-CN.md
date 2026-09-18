# HiveTask

[English](./README.md) · **简体中文**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-blue)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()

HiveTask（谐音 "Have a task"）是一个跨平台桌面工作台，围绕本地 Git 仓库管理
Issue 与 Pull Request。当前对接 GitHub——通过已完成认证的
[`gh`](https://cli.github.com) CLI 通信，并把数据缓存到仓库旁的 SQLite
数据库中，离线也可查看。

产品方向是**多来源的仓库工作台**：在同一套数据模型与缓存之上，逐步接入
自建 Gitea/GitLab（局域网团队）与纯本地仓库（无 remote），并在统一模型上
提供 Projects 式看板。详见下方「路线图」。

## 功能特性

- **以仓库为中心**：选择任意本地 Git 文件夹即可，仓库归属由 git remote
  自动解析；最近使用的仓库会被记住。
- **多来源**：GitHub（经 `gh` CLI）、自建 **Gitea**（局域网团队）与纯本地仓库统一在同一
  个 `Source` 抽象之上；无 remote 的仓库开箱可用本地 Issue（git 事件日志为持久真源）。
- **Issue / PR 工作台**：按状态浏览（Issue：Open / Closed / All；PR：
  Open / Closed / Merged），列表—详情双栏展示标签、里程碑、负责人、作者
  与日期。
- **写操作（写穿透）**：评论、关闭 / 重开、合并（merge / squash / rebase）；
  乐观更新、失败回滚、错误就近双语提示。
- **Projects 式看板**：本地项目层上的 Board / Table / Roadmap 三视图，聚合 Issue、PR
  与草稿卡；可镜像 GitHub Project（拉取先行，列配置可回发布）。
- **知识库工作区**：任意文件夹即知识库——懒加载文件树、CodeMirror 6 Markdown 编辑器
  （表格 / 待办 / KaTeX 公式 / Mermaid 图表实时预览）、**可编辑的代码文件**（同一套编辑器
  骨架 + 按语言语法高亮，⌘S 保存、原编码回写、外部改动冲突检测）、音视频播放
  （音频 / 视频 / HLS / FLV / MPEG-TS / LRC 歌词）、文档类富预览（PDF、Office、OFD/XPS、
  EPUB）、3D 模型、CAD 图纸与 GIS 数据；其余格式一律"用默认应用打开"。
- **工具工作区**：Git 历史泳道图（分支条、ahead/behind、手动 fetch）与
  集成终端（xterm.js + PTY，shell 可选）。
- **日历**：月 / 列表视图投影里程碑、Issue·PR、项目日期字段与本地提交热力；iCal
  订阅（Google / Outlook 私密地址、节假日、节气）支持逐订阅配色；日格农历副行；
  断网读缓存。
- **可调分栏**：基于可拖拽、可嵌套分栏的工作台布局，布局持久化。
- **本地优先缓存**：拉取的数据通过版本化迁移写入
  `<repo>/.hivetask/hivetask.db`（SQLite），无网络时仍可读取。
- **一键跳转**：从任意 Issue / PR 直接在浏览器打开对应 GitHub 页面。
- **原生桌面**：基于 Tauri 打包，支持 macOS、Windows 与 Linux；明暗主题
  三态、中英双语、原生应用菜单与状态栏。

## 路线图

| 阶段 | 内容 |
|------|------|
| 当前 | 多来源仓库工作台——GitHub / Gitea / 本地库：Issue·PR 工作台、Projects 式看板（Board / Table / Roadmap）、知识库工作区、工具（Git 历史 / 终端 / 日历） |
| 近期 | 日历日程与提醒（S4）；Gitee / GitLab 来源；同步间隔偏好 |
| 中期 | 跨来源聚合与报表；知识库图谱；项目甘特图 |
| 后续 | 多端同步端点与账号（商用前瞻） |

PR 审查（diff、行内评论、approve、CI checks）不在桌面端复刻，一律跳转浏览器。

## 技术栈

| 层 | 选型 |
|------|------|
| 桌面壳 | Tauri 2（Rust 后端 + 系统 WebView） |
| 前端 | Vue 3（`<script setup>`）· TypeScript · Pinia · Vite |
| 本地核心 | Rust：gh 子进程封装（GitHub 来源）、git2-rs（历史与分支）、portable-pty（终端）、serde_json 解析、rusqlite |
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
│  gh.rs（GitHub 来源：gh CLI 调用 / JSON 解析）│
│  git.rs（git2-rs 历史与分支）· pty.rs（终端） │
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
│   ├── panels/              #   Issue / PR 列表与详情面板
│   ├── knowledge/           #   知识库工作区（文件树 + CM6 编辑器/预览）
│   ├── stores/              #   Pinia store（仓库、Issue/PR、同步、设置）
│   ├── api.ts               #   Tauri command 的类型化封装
│   └── types.ts
├── src-tauri/src/
│   ├── lib.rs               # Tauri command 接口层
│   ├── gh.rs                # GitHub 来源（gh CLI 调用与 JSON 解析）
│   ├── git.rs               # git2-rs 提交历史与分支
│   ├── pty.rs               # 集成终端 PTY
│   ├── kb.rs                #   知识库文件接口（沙箱 + 编码 + 外部打开）
│   ├── storage.rs           # SQLite 迁移与缓存
│   ├── models.rs            # 共享数据模型
│   └── migrations/          # 版本化 SQL 迁移
├── index.html
└── package.json
```

## 致谢

本项目站在别人的工作之上。**带许可义务**的致谢统一记在
[THIRD-PARTY.md](./THIRD-PARTY.md)（第三方声明的唯一事实源）。简述：

- **编辑器栈（Markdown 即时渲染）** —— 从 **[SoloMD](https://github.com/zhitongblog/solomd)**
  （MIT，© 2026 xiangdong li）**逐文件对照移植并按我们的规范改写**：输入法组字守卫、记号显隐、
  行内/块级渲染，以及文件树的实现思路。
- **资源管理器度量与行为** —— 参照 **[Visual Studio Code](https://github.com/microsoft/vscode)**
  （MIT，© Microsoft）：树行高、缩进步长、页签形态；其中四枚动作图标原样取自
  **[@vscode/codicons](https://github.com/microsoft/vscode-codicons)**（**CC BY 4.0**）。
- **公式与图表** —— **[KaTeX](https://katex.org)**（代码 MIT；**字体 SIL OFL 1.1**）与
  **[Mermaid](https://mermaid.js.org)**（MIT），全部本地渲染、无远程服务。
- **编辑器内核** —— **[CodeMirror 6](https://codemirror.net)**（MIT）。
- **预览蓝图** —— **[open-file-viewer](https://github.com/xushanpei/open-file-viewer)**
  （MIT）：各格式预览插件逐文件对照移植（20 个插件覆盖其全格式面），其默认 CDN 路径全部改由随包资源承担；
  OFD / XPS / LRC / DXF 为自研解析，逐格式对照见 [`docs/kb-preview-formats.md`](./docs/kb-preview-formats.md)。
- **媒体播放** —— **[hls.js](https://github.com/video-dev/hls.js)**（Apache-2.0）负责 HLS
  播放列表（分片经自定义 loader 从知识库本地读）；**[mpegts.js](https://github.com/xqq/mpegts.js)**
  （Apache-2.0）负责 FLV / MPEG-TS。
- **日历** —— **[FullCalendar](https://fullcalendar.io)** v6（MIT；锁 v6 线是因为 v7 视图插件尚未跟上）负责月/列表网格；**[chinese-lunisolar-calendar](https://crates.io/crates/chinese-lunisolar-calendar)**（MIT）负责农历。节假日与节气数据一律来自用户自建 iCal 订阅，不随包内置。
- **评估未采用** —— MarkText/muya、Vditor、headless-tree（结论留在 THIRD-PARTY.md，避免重复评估）。

## 许可证

[AGPL-3.0-only](./LICENSE) © 2026 Barbossa

本项目是自由软件：你可以在 GNU Affero 通用公共许可证 v3.0 的条款下使用、
学习、修改和再分发。若将修改后的版本作为网络服务提供，必须以同一许可证向
用户提供修改后的源码（AGPL 第 13 条）。如需 AGPL 之外的商业授权，请联系作者。
