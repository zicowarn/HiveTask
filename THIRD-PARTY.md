# 第三方软件与许可（Third-Party Notices）

本文件列出 HiveTask 分发时携带的第三方组件、**逐文件对照移植**的代码来源，
以及必须随包保留的许可与版权声明。事实源：`docs/plan-knowledge-workspace.md` §10。

HiveTask 自身以 **AGPL-3.0-only** 发布（见 `LICENSE`）。下列许可均与本项目兼容；
各组件仍归其各自作者所有。

---

## 一、随包分发的资产（有署名/许可保留义务）

| 组件 | 许可 | 版权 | 用在哪 | 义务 |
|---|---|---|---|---|
| **@vscode/codicons**（VS Code 图标集） | **CC BY 4.0** | Copyright (c) Microsoft Corporation | `src/components/EditorIcon.vue` 的 `c.*` 族：新建文件 / 新建文件夹 / 刷新 / 折叠全部（4 条路径原样取自 `@vscode/codicons@0.0.36`） | 署名 + 标明来源；已在本文件与 README 致谢中注明 |
| **KaTeX 字体** | **SIL OFL 1.1** | Copyright (c) 2009-2010 Design Science, Inc.；2014 Khan Academy（保留字体名 KaTeX_*） | `katex/dist/fonts/*.woff2` 由 `katex.css` 打包进产物（19 个文件，约 1.1 MB）——离线排版公式所必需 | 保留版权与许可原文；不得单独售卖字体；不得用保留字体名发布改版 |
| **libredwg-web.wasm**（LibreDWG 的 WebAssembly 构建） | **GPL-3.0**（npm 包 `@mlightcad/libredwg-web@0.7.10` 声明的许可） | LibreDWG 项目 / @mlightcad 打包 | `dist/vendor/libredwg/libredwg-web.wasm`（9.5 MB，**只在打开 .dwg 时加载**）——DWG 图纸预览 | 分发时**附许可全文与来源声明**：`resources/licenses/LICENSE-GPL-3.0.txt` 与 `NOTICE-libredwg-web.txt` 由构建拷到 `dist/vendor/libredwg/licenses/`。<br>兼容性：AGPL-3.0 第 13 条允许与 GPL-3.0 组件结合分发，整体仍按 AGPL-3.0 提供（本仓库已公开源码）。<br>⚠️ 该组件是**唯一**的强 copyleft 第三方件；不想要它时可只删 DWG 路径（DXF 为自研解析，不依赖它），见 `docs/kb-preview-formats.md` §5.5 |
| **holiday-cn 法定假日数据**（2025/2026 JSON，vendored） | MIT | Copyright (c) 2019 NateScarlet | `src-tauri/src/calendar_data/holiday-cn-{2025,2026}.json`（`include_str!` 进二进制，运行时零网络） | 保留版权与许可声明；**更新方式 = 随版本重新抓取** raw.githubusercontent.com/NateScarlet/holiday-cn（每日自动同步国务院公告，含 isOffDay 放假/调休语义） |
| **Visual Studio Code**（行为与度量参照） | MIT（代码） | Copyright (c) Microsoft Corporation | 未复制其代码；仅参照资源管理器/编辑器页签的**度量与行为**（行高 22px、缩进步长、页签形态等），并在交付说明中逐项标注 | 按 MIT 习惯在致谢中注明参照对象 |

## 二、逐文件对照移植（含修改）

以下代码**读其源码后在本仓库重写**，按 MIT 条款保留署名与许可、并标明我们的修改。

| 来源 | 许可 | 版权 | 落在我们仓库的文件 | 我们的修改 |
|---|---|---|---|---|
| **SoloMD**<br>https://github.com/zhitongblog/solomd | MIT | Copyright (c) 2026 xiangdong li | `src/knowledge/editor/ime-guard.ts`（组字冻结守卫）<br>`src/knowledge/editor/live-preview.ts`（标记显隐 + 富文本样式）<br>`src/knowledge/editor/math-diagram.ts`（KaTeX / Mermaid 块级替换）<br>`src/knowledge/editor/live-render.ts`（列表圆点 / 待办复选框 / 分隔线） | 样式改走本仓库 token（`--font-*`、`--text`、`--accent` 等）；复选框改为自绘方框 + 内联 SVG 勾（避免平台把 ☑ 渲染成方框或彩色 emoji）；补跨行 `$$` 块级公式；去掉其 PlantUML/vega 等远程依赖路径 |
| **SoloMD**（文件树骨架） | MIT | 同上 | `src/knowledge/KnowledgeTree.vue` / `KnowledgeTreeNode.vue`（懒加载、右键、内联编辑的思路与踩坑结论） | 按 VS Code 度量与我们的 token 重写；排序走 `localeCompare("zh-Hans-CN")` |
| **SoloMD**（Rust 文件层做法） | MIT | 同上 | `src-tauri/src/kb.rs`（`chardetng` 探测 + `encoding_rs` 按原编码回写、`trash` 回收站删除的做法） | 自建根沙箱（`resolve_in_root`：拒绝 `..`、绝对路径、符号链接逃逸）；忽略规则复用已有 git2；新增 mkdir/新建文件语义 |
| **open-file-viewer**<br>https://github.com/xushanpei/open-file-viewer | MIT | Copyright (c) 2026 xushanpei | `src/knowledge/preview/registry.ts`（插件契约与"扩展名优先、magic 兜底"判定）<br>`src/knowledge/preview/plugins/*.ts`（18 个插件的判定口径与降级策略） | 逐条排除其默认 CDN：PDF 的 cmaps/standard_fonts/wasm 与 worker 本地化、leaflet 样式本地化且**底图默认关闭**、剔除 PlantUML 等远程渲染；OFD/XPS/LRC/DXF 改为自研解析（见 `docs/kb-preview-formats.md`） |

## 三、运行时依赖（npm）

全部为宽松许可（MIT / Apache-2.0 / BSD / ISC / MIT-0）；**版权与许可原文在各包内随包保留**。
下表许可按各包 `package.json` 的 `license` 字段**逐个核对过**（不凭印象填）。

| 包 | 许可 | 用途 |
|---|---|---|
| `vue`、`pinia` | MIT | 前端框架与状态管理 |
| `@codemirror/{state,view,language,commands,lang-markdown}`、`@lezer/highlight` | MIT | 知识库的 Markdown 编辑器（live preview） |
| `katex` | MIT（代码）+ SIL OFL 1.1（字体，见上） | 公式排版 |
| `mermaid` | MIT | 图表渲染（本地渲染，无远程服务） |
| `markdown-it` | MIT | Issue / PR 正文的 Markdown 渲染 |
| `@xterm/xterm`、`@xterm/addon-fit` | MIT | 集成终端 |
| `@fullcalendar/{core,vue3,daygrid,list,interaction}`（**锁 6.1.21**） | MIT（core 内含私有 preact 依赖） | 日历面板（工具类目）：月/列表视图 + 拖拽；WKWebView 六项扫描零命中，样式由包内 JS 注入 |
| `@web-git-graph/{web,protocol}` | MIT | Git 历史泳道图 |
| `@tauri-apps/api`、`@tauri-apps/plugin-{dialog,opener,store}` | MIT OR Apache-2.0 | 桌面壳能力 |
| `pdfjs-dist` | Apache-2.0 | PDF 预览（cmaps / 标准字体 / wasm 全本地，见 `docs/kb-preview-formats.md` §2） |
| `docx-preview` | Apache-2.0 | Word（docx）预览 |
| `mammoth` | BSD-2-Clause | Word 预览的回退路径（docx-preview 失败时） |
| `xlsx`（SheetJS） | Apache-2.0 | 表格（xlsx/xls/csv/ods）预览 |
| `jszip` | MIT OR GPL-3.0-or-later（**我们按 MIT 使用**） | zip 系容器解析（压缩包 / docx / OFD / EPUB / XPS / XMind / KMZ） |
| `pako` | MIT AND Zlib | 压缩流（zip 内 deflate） |
| `prismjs` | MIT | 代码高亮 |
| `postal-mime` | MIT-0 | 邮件（eml）解析 |
| `dompurify` | MPL-2.0 OR Apache-2.0 | 清洗不可信 HTML（邮件 / EPUB 章节 / CAD 输出的 SVG） |
| `three` | MIT | 3D 模型（glTF/GLB/OBJ/STL/PLY/VRML）预览 |
| `leaflet` | BSD-2-Clause | GIS 矢量预览（底图默认关闭） |
| `shpjs` | MIT | Shapefile 解析 |
| `@mapbox/togeojson` | BSD-2-Clause | KML / GPX → GeoJSON |
| `topojson-client` | ISC | TopoJSON → GeoJSON |
| `hls.js` | Apache-2.0 | `.m3u8` 播放（自定义 loader 走知识库本地文件） |
| `@mlightcad/libredwg-web`（含 wasm） | MIT | DWG 解析（wasm 只在打开 .dwg 时加载） |

## 四、运行时依赖（Rust / crates.io）

| crate | 许可 | 用途 |
|---|---|---|
| `tauri`、`tauri-build`、`tauri-plugin-{dialog,opener,store,log}` | Apache-2.0 OR MIT | 桌面壳与插件 |
| `serde`、`serde_json`、`anyhow`、`log`、`keyring`、`reqwest`、`git2` | MIT OR Apache-2.0 | 序列化 / 错误 / 日志 / 凭据 / HTTP / Git |
| `rusqlite`（bundled SQLite） | MIT | 本地缓存与登记库 |
| `portable-pty` | MIT | 终端 PTY |
| `encoding_rs` | (Apache-2.0 OR MIT) AND BSD-3-Clause | 按原编码读写文本（中文遗留文件） |
| `chardetng` | Apache-2.0 OR MIT | 编码探测（Firefox 的探测器） |
| `chinese-lunisolar-calendar` | MIT | 日历面板农历副行（公历↔农历转换，1901–2101，简体变体 `{:#}`） |

---

## 评估过但**未采用**的组件（留痕，避免重复评估）

| 组件 | 许可 | 结论 |
|---|---|---|
| **MarkText / muya**（`@muyajs/core`） | MIT | 评估为**备选内核**：WYSIWYG 全内置（表格就地编辑、KaTeX+mhchem、Mermaid 块），零 Electron 依赖；未采用原因见 `docs/plan-knowledge-workspace.md` §2.2 |
| **Vditor** | MIT | 评估其 IR（即时渲染）模式；因其为自带 DOM/CSS/工具栏/i18n 的整体件、图标自绘、按需资源默认走 unpkg 而放弃 |
| **@headless-tree/core** | MIT | 评估为树组件候选；因自绘成本可控且需匹配本仓库 token 而放弃 |
| **TOAST UI Calendar**（`@toast-ui/calendar`） | MIT | **停更**（2022-08 后无发版）且无官方 Vue3 封装（`@toast-ui/vue-calendar` 为 Vue2）；npm 上的 `tui.calendar` 包名不存在（那是 GitHub 仓库名） |
| **@praisesink/calendarcn** | MIT | shadcn-vue 系（peer 依赖 tailwind-merge/cva/reka-ui），本仓库无 Tailwind 体系；周下载量个位数，维护风险高 |
| **v-event-calendar** | MIT | 早期阶段（v0.0.x，周下载量两位数），功能与维护不足以承载日历面板 |
| **@schedule-x/{calendar,vue}** | MIT | peer 依赖 preact + @preact/signals（第二套运行时显式入包）；FullCalendar v6 的 preact 为其私有内嵌实现，暴露面更小 |
| **Vikunja** | AGPL-3.0 | 「笔记+任务+日历」产品架构可参考，**代码不可复制**——本项目为 AGPL-3.0-only，混入他方 AGPL 代码会锁死未来双许可/闭源的企业化路线（2026-09-17 日历选型讨论） |

> FullCalendar 许可注意：标准插件 MIT；**Premium 插件对 AGPLv3 项目免费**（官方条款，v7 起以 AGPLv3 替代 GPLv3 作为开源豁免许可）——该豁免以项目保持 AGPL 为前提，与上条 Vikunja 留痕同属「开源策略与第三方许可的耦合」决策，动许可前须复核。

---

_如发现遗漏或分类有误，请提 issue 或直接修改本文件——本文件是许可合规的唯一事实源。_
