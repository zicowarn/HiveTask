# 知识库 workspace — 实施计划（v2，深度分析版）

> 状态：**计划（未开工）**。口径由用户 2026-09-16 定案；v2 补全编辑器内核、文件树参照、OFV 全量三处分析。
> 参照物：**VS Code**（侧栏行为/度量）、**SoloMD**（CM6 编辑器栈 + FileTree 实现，MIT）、
> **MarkText / muya**（WYSIWYG 引擎，MIT）、**open-file-viewer**（预览蓝图，MIT）。
> 纪律：AGENTS.md R1–R7（取证 → 照抄 → 适配；形态验证；对照表留痕）。

---

## 1. 需求口径（已定）

1. **新增「知识库」workspace**，位置在「项目」右侧：issues → pulls → projects → **knowledge** → tools。
2. **根 = 一个可切换的文件夹**（复用「切换仓库 / 切换项目」对话框模式 + 最近列表）。
3. **结构 = 单面板工作区**（与「项目」同款：`listPanel === detailPanel`，只注册**一个** `knowledge.workbench`）——
   **面板内部**才是"左树 + 右编辑器/预览"，内部用既有 `SplitPane` 原语分栏。
   ⚠️ **不用 issues 那种「列表 + 详情」双面板模型**：树与编辑器是耦合的一体，双面板下类型切换器能把文件树整块换成别的面板、
   能把两者拆开、能单独关掉其中一半——都会出问题（用户 2026-09-16 修正）。
4. **右侧分两条路**：
   - **Markdown = 就地 WYSIWYG 编辑**（Typora 式边写边渲染），必须支持 **Mermaid + KaTeX 公式**
     ——参照 SoloMD / MarkText 要解决的正是这件事；
   - **其余格式 = 只预览**（以 OFV 为蓝图的本地实现）；**它们的"编辑"交给系统默认程序**——
     预览面板提供「用默认程序打开」与「在访达/资源管理器中显示」两个动作，**不在应用内编辑**。
5. **OFV 全量，不分期**：27 个格式插件全部移植，但**只做预览（只读）**（详见 §2.4）。
6. **硬约束**：完全离线（**无任何 CDN / 远程服务**）、不引 `@open-file-viewer/*` 依赖、中文场景必须过关。

---

## 2. 取证汇总

### 2.1 VS Code 侧栏（形态与度量基线）

来源：`/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.css`
（1.6 MB 编译产物）+ `workbench.desktop.main.js` + `extensions/theme-defaults/themes/*_modern.json`。

| 项 | 实测值 | 来源 |
|---|---|---|
| 树行高 | **22px**（`height`/`line-height` 同为 22） | `.explorer-item` |
| 展开箭头单元格 | 宽 **16px**、`font-size:10px`、`padding-right:6px`、`translate(3px)` | `.monaco-tl-twistie` |
| 缩进步长 | 由设置 `workbench.tree.indent` 控制（**默认 8px**），与行高联动 `Math.max(22 - indent, 0)` | `.js` 中 `workbench.tree.indent" ), v = Math.max(22 - f, 0)` |
| 缩进容器 | `position:absolute; top:0; left:16px` | `.monaco-tl-indent` |
| 缩进参考线 | `1px` border-left、`opacity` 过渡 `.1s linear` | `.indent-guide` |
| 图标 | 16px 背景位、`height:22px`、`padding-right:6px`；容器 `16×22` + `margin-right:6px` | `.monaco-icon-label:before` / `.monaco-icon-label-iconpath` |
| 行内边距 | 左 `2px`；行尾 `12px` | `.monaco-list-row` / `.explorer-item-with-test-coverage …:after` |
| 侧栏色值（dark） | `sideBar.background #181818`、`border #2B2B2B`、`foreground #CCCCCC`、`activityBar.activeBorder #0078D4` | `dark_modern.json` |
| 悬停/选中（light 实测） | `list.hoverBackground #E8E8E8`、`list.activeSelectionBackground #E8E8E8` / `Foreground #000000` | `light_modern.json` |
| 悬停/选中（dark） | `dark_modern.json` 未定义 → CSS 内建兜底 `#2a2d2e` / `rgba(0,122,204,.25)` | CSS `var(…, 兜底值)` |

⚠️ **欠一张 VS Code Explorer 实机截图**（R3 比对用）。我两次尝试截图时前台被浏览器占据、误拍到别的窗口，已删除误拍文件，未使用。

### 2.2 编辑器内核候选（关键决策）

**候选 A：muya（`@muyajs/core`）** — MarkText 的 WYSIWYG 引擎
- 许可 **MIT**，**已发布 npm**（0.2.0，2026-05-20），仓库 `marktext-develop` 为活跃 monorepo（0.20.0-dev）。
- **零 Electron / Node 依赖**（全仓库 grep 无 `require('electron')` / `process.platform`）→ 浏览器引擎，可直接挂进 Vue 3 外壳。
- 源码 **85,018 行**；导出面很宽：`Muya`（编辑器）、`MarkdownToHtml`、`renderToStaticHTML`、`getTOC`，
  以及**全部块级交互工具**：`TableChessboard`（表格棋盘插入）、`TableDragBar`、`TableRowColumMenu`、
  `TableColumnToolbar`、`ImageResizeBar`、`ImageToolBar`、`ImageEditTool`、`InlineFormatToolbar`、
  `LinkTools`、`ParagraphFrontButton/Menu`、`ParagraphQuickInsertMenu`、`EmojiSelector`、
  `FootnoteTool`、`CodeBlockLanguageSelector`、`PreviewToolBar`。
- 表格为**就地编辑**：`src/block/gfm/table/{table,row}.ts` + `src/block/content/tableCell/`，
  带 5 组 handler 测试（`tabHandler` / `arrowHandler` / `enterHandler` / `backspaceSafety` / **`composeHandler`**）。
  `composeHandler` 解决的是**中文输入法在空单元格的组字丢失**（`compositionstart` 时空单元格塞 `\u200B`，`compositionend` 去掉）。
- **Mermaid + KaTeX 是内置块**（与本项目三条硬需求一一对应）：
  - 公式：`src/block/extra/math/`（`mathPreview.ts` 直接 `import katex`，并加载 `katex/dist/contrib/mhchem.mjs`；
    带 `mhchem.spec` / `mathErrorMessage.spec` 测试）；
  - 图表：`src/block/extra/diagram/`（`diagramPreview.ts` 支持 **mermaid** / flowchart / sequence / vega-lite / plantuml）；
    另有 `content/langInputContent` 的 `diagramLanguage` 语言选择与 `ui/tableChessboard` 等块级交互件。
  → **WYSIWYG + Mermaid + KaTeX 三条需求不需要自研**，这是选 muya 的决定性证据。
- 主题走 **CSS 变量**（`--editor-bg-color`、`--editor-color`、`--icon-color`、`--code-block-bg-color`、`--blockquote-*`、
  `--link-color`、`--hr-color`、`--float-*`、`--button-*`、`--editor-area-width`…约 40 个）→ **可整体映射到我们的 token**。
- i18n：导出 `ILocale` + 10 个语言（含 `zhCN` / `en`）→ 直接喂我们的文案。
- 字体**已内置随包**（`assets/styles/fonts/`：DejaVu Sans Mono + Open Sans + 各自 LICENSE）→ 离线可用（需在第三方声明里附上两份字体许可）。
- ⚠️ 离线必修点（见 §5）：`config/index.ts:333` 的 `plantumlServer` 默认指向 `www.plantuml.com`；
  `state/markdownToHtml.ts:23-28` 导出的 HTML 里内嵌 3 个 CDN `<link>`（该导出路径我们不用，但需确认不走）。

**候选 B：CodeMirror 6 + live-preview** — SoloMD 路线
- SoloMD（MIT，Tauri2+Vue3）已把这条路走通：`src/lib/cm-*.ts` **5,455 行**。
- **Mermaid 与 KaTeX 已是就地渲染**（v2 计划里我误认为需要自研，实际是"照抄"即可）：
  `cm-live-blocks.ts:49-51` 直接 `import mermaid` / `katex` / `katex/contrib/mhchem`；
  `:302` `katex.renderToString(...)` 渲染行内/块级公式；`:66-74` 建 mermaid SVG 缓存 + `:827` 识别 ```` ```mermaid ```` 围栏 →
  `:388` `cm-live-block--mermaid` widget；`:1159` 起是其样式。
- 核心必需件行数：`cm-live-blocks.ts` 1246（**表格/公式/mermaid 的块级 widget 与区间逻辑**）、`cm-live-render.ts` 833（行内 widget）、
  `cm-live-preview.ts` 248（HighlightStyle + 隐藏标记符）、`cm-ime-guard.ts` 128（组字冻结）、`cm-cjk-emphasis.ts` 148。
- **表格与公式是"弹窗式"编辑**：表格折叠为 widget，编辑走 `TableEditor.vue`（**430 行**）；
  公式走 `FormulaEditor.vue`（**403 行**）+ `*-bus.ts`（各 29/35 行）桥接。另有 `Editor.vue` 3,904 行（含页签/面板外壳）。
- IME：`cm-ime-guard.ts` 记录 issue #108（组字中重建 decoration → Windows WebView2 丢组字）；
  其 bus 注释还提到存在**Windows 纯 textarea 兜底编辑器**（`whether that editor is CodeMirror or the Windows plain-textarea one`）。
- 依赖：55 个运行时依赖（21 个 `@codemirror/*` + `markdown-it` 生态 + `mermaid`/`katex`/`highlight.js`/`get-east-asian-width`）。

**量化对比**

| 维度 | A. muya | B. CM6 + live-preview（SoloMD） |
|---|---|---|
| 编辑形态 | 全 WYSIWYG（MarkText 式，标记符不出现） | live preview（标记符仅光标所在行显形）+ 块级 widget——**与 Typora 本体的行为一致** |
| Mermaid | 内置块（`block/extra/diagram/`，另含 flowchart/sequence/vega-lite/plantuml） | **已有**：`cm-live-blocks.ts:49,66-74,827,388`（mermaid.render + SVG 缓存 + 围栏识别 + widget） |
| KaTeX | 内置块（`block/extra/math/` + mhchem） | **已有**：`cm-live-blocks.ts:302` `katex.renderToString` + `katex/contrib/mhchem` |
| 表格 | **就地编辑**（棋盘插入 / 拖拽栏 / 行列菜单，5 组 handler 测试） | widget 展示 + **弹窗** `TableEditor.vue`（430 行） |
| 代码量与控制力 | 85,018 行外部引擎（MIT，已发布 npm）；我们只做适配 | **移植 ≈5,500 行**（cm-* 5,455 里的核心 + TableEditor 430 + FormulaEditor 403）→ 代码在**我们仓库**，可读可改 |
| 运行时依赖 | 27 个（含 vega 系 / flowchart.js / plantuml-encoder / snapsvg / rxjs / underscore） | 55 个（21 个 `@codemirror/*` + markdown-it 生态 + mermaid/katex/highlight.js） |
| Markdown 保真 | md ↔ 内部状态；有专门往返测试（`stateToMarkdown.spec` / `blockSerialization.spec` / `codeFenceLength.spec` / `referenceLink.spec`…） | **缓冲区即 md 源，零失真** |
| 离线 | 字体是**本地** `@font-face`（`local()` + woff；`webfontloader` 为空跑依赖）；⚠️ **PlantUML 默认走远程服务器**，须关 | 无远程依赖 |
| 平台风险（**均未实测**） | MarkText 仅在 Chromium 验证过；WKWebView 下 contenteditable/IME 未知 | 其注释显示它为 Windows 备了纯 textarea 兜底 → live-preview 在 WebView2 也有坑；macOS 未知 |
| 商用许可 | MIT（+ 字体可剥离，见下） | MIT（移植后可完全自持） |

**许可与商用（澄清）**：**Apache-2.0 / MIT / SIL OFL 1.1 都是可商用许可**，义务只是保留版权与许可原文、
标明修改、字体不得单独售卖、OFL 的保留字体名不得用于改版。muya 字库 = Open Sans（**Apache-2.0**）+
DejaVu Sans Mono（Bitstream Vera），KaTeX 字体 = **OFL 1.1**（代码 MIT）。
且本项目自身是 **AGPL-3.0-only**，比上述任何一种都严格——真正的商用约束来自我们自己的许可，不来自这些字体。
实操上还建议**不打包 muya 字库**：Open Sans **没有 CJK 字形**，中文知识库用系统字体栈（PingFang SC / 微软雅黑）观感更好、体积更小、许可事项更少。

**决策（2026-09-16 用户拍板）：主路线 = B（SoloMD 的 CM6 栈）+ 不打包 UI 字库。**
A（muya）降为**备选**：仅当 B 在 T0 触到硬门槛且不能在合理成本内修掉时回退。

- 选 B 的理由（结构性，不靠偏好）：知识库的文件是**唯一真源**（磁盘 .md，常进 git），CM6 的缓冲区就是 markdown 原文 → **保存零改写**；
  代码归我们（≈5,500 行 MIT 实现照抄进仓库，可读可改）；与现有栈同源（Vue3/TS/Vite/Tauri）；
  无 UI 字库负担；live preview 形态与 **Typora 本体**一致（光标行显标记、其余行渲染）。
- **接受的代价**（写清楚，不事后抱怨）：表格与公式是**弹窗式编辑**（`TableEditor.vue` 430 + `FormulaEditor.vue` 403），
  **观感弱于 muya 的就地编辑**；且这 ≈5,500 行要我们自己长期维护（边界情况得自己接）。
- MIT 义务：照抄保留版权声明并标明来源（文件头 + §10 + `THIRD-PARTY.md`），不做静默照抄。

**"不打包字体"的准确含义**（重要，涉及 KaTeX 能否成立）：

| 字体 | 处置 | 原因 |
|---|---|---|
| 编辑器 UI 拉丁字库（Open Sans 等） | **不打包** | 中文场景无用（无 CJK 字形），且新版路线（CM6）本就不带 |
| 界面 / 正文 / 代码字体 | **系统字体栈**：`-apple-system, "PingFang SC", "Microsoft YaHei"` + 等宽 `SF Mono / Menlo / Consolas` | 中文观感最好、体积为零 |
| **KaTeX 数学字体** | **必须随包**（只发 `woff2` 子集，约 MB 级） | KaTeX 靠 `@font-face` 排版，缺字体公式会错乱——这是三条硬需求之一，不能省；许可 OFL 1.1 可商用 |
| Mermaid / Prism | 无需字体 | 走 SVG 与系统字体 |

**T0 的判定规则（先定规则再测，避免事后找理由）**：

| 类型 | 条目 | 处置 |
|---|---|---|
| **硬门槛**（任一不过即淘汰该引擎） | ① 中文拼音连打无吞字/回删 ② **md 往返 diff 为空**（打开→不改→保存）③ 断网完全可用 | ① 两边都要过；② 主要压 A（B 结构性满足）；③ 两边都要过 |
| **打分项** | 表格编辑体验 / 长文（≥200 行）输入与滚动延迟 / 主题映射到我们 token 的工作量 / 集成或移植工作量 / 依赖与产物体积 | 逐项 1–5 分，记录**决定性证据** |

### 2.3 文件树三参照对比（回答「还需要参考 VS Code 吗」）

**需要，但只作为行为清单与度量的来源；代码骨架从 SoloMD 来。**

| 参照 | 能提供 | 缺口 |
|---|---|---|
| **VS Code** | 完整桌面级行为集 + **精确度量**（§2.1）：22px 行高、16px 箭头、8px 缩进步长、1px 缩进线、16×16 图标、2px 行内边距；成熟行为：预览页签（斜体，被下次单击替换）、多选、拖放、键盘导航、面包屑、行内重命名、过滤、git 状态角标 | 不是我们的技术栈；色值属 VS Code 调色板，**必须映射到我们既有 token**（③适配，需标注） |
| **SoloMD `FileTree.vue`** | **2,050 行可直接借的实现骨架**（Vue3 + TS + Tauri，同栈）：懒加载、右键菜单、内联新建/重命名（**自带 IME 守卫**，见其 `CJK / IME guard for the rename / new-file inline input`）、拖放（**合法落点判定** + **撤销式移动** toast）、删除撤销窗口、扩展名筛选、显示隐藏、宽度拖拽、**根目录失效检测**（`workspace folder itself is gone` 空态）；其注释还记录了 Tauri 的 `dragDropEnabled` 会吞掉页面内拖放（#86/#131）——**我们这个仓库已踩过同一个坑** | 视觉非 VS Code 形态（`indent = 8 + depth*12`，行字号 12.5–13px）；无多选 / 预览页签 / 面包屑 / 键盘导航 |
| **MarkText 侧栏** | 结构最简的 Vue3 参照（`tree.vue`485 + `treeFolder`183 + `treeFile`149 + `treeCtrl`257 ≈1,200 行 + 独立右键菜单目录）；其 sidebar 另有**全文搜索**（`search.vue` 452 + `searchResultItem` 283）与 **TOC**（`toc.vue` 147）——知识库后续要用的两个能力 | **无拖放**；排序（title/mtime）、增删由 `treeCtrl` 管 |

### 2.4 OFV 全量账单（27 个插件，不分期）

参照源码：`packages/core/src` **非测试 36,859 行**。

| 组 | 插件（行数） | 依赖 |
|---|---|---|
| 文本类 | `text`(1046) `detect`(556) `viewer`(1761) `fallback`(93) `utils`(141) | prismjs |
| 文档 | `pdf`(1043) `office`(9566) `ofd`(1241) `xps`(521) `epub`(492) | pdfjs-dist、docx-preview、mammoth、xlsx、emf-converter、@aiden0z/pptx-renderer、jszip |
| 旧格式 | `msdoc`(1982) `msppt`(1028) `wordml`(537) `oasis-binary`(720) | pako、xlsx |
| 媒体 | `image`(1076) `video`(758) `audio`(543) `lrc`(464) `asset`(3258) | heic2any、utif、ag-psd、hyparquet、hls.js |
| 其它 | `archive`(979) `email`(602) `drawing`(1671) `xmind`(881) | jszip、pako、seek-bzip、xz-decompress、postal-mime、@kenjiuno/msgreader、dompurify |
| 重格式 | `model3d`(533) `cad`(2937) `cad-dwg`(897) `cad-webgl`(185) `gis`(534) | three、@mlightcad/{cad-simple-viewer,data-model,libredwg-web}、leaflet、shpjs、@mapbox/togeojson、topojson-client |

**全量意味着接受的代价**：依赖树显著变大（three + vega 级别的包进来）、CAD 需 wasm 资源、
GIS 需要取舍（见 §5.10）。这些都要在实现时逐个实测体积并记录，不预设结论。

---

## 3. 选型结论

| 决策 | 结论 | 依据 |
|---|---|---|
| 编辑器内核 | **muya（依赖方式）优先，spike 定案**；CM6 作为源码模式后置 | §2.2；架构上留 `EditorEngine` 缝隙，换内核不推翻外壳 |
| 表格 / 公式 / 图表 / 块级交互 | **由 muya 提供**（表格就地编辑、KaTeX+mhchem、Mermaid 等图表块、图片缩放、段落菜单…） | 三条硬需求与 muya 的块类型一一对应（§2.2），自研量为 0；避免"编辑器一套、预览一套"的双实现 |
| 非 Markdown 文件的"编辑" | **不在应用内做**：预览面板给「用默认程序打开」+「在访达中显示」 | 用户口径；同时省掉 docx/xlsx/pdf 的写回、冲突检测与格式保真问题 |
| mermaid / KaTeX / 代码高亮 | 编辑器与预览端**共用一份**实现 | 否则两套渲染结果会漂移 |
| 文件树 | 行为与度量照 **VS Code**；实现骨架借 **SoloMD**；搜索/TOC 参照 **MarkText** | §2.3 |
| 文件系统层 | Rust 命令 + `chardetng` + `encoding_rs`（照 SoloMD） | SoloMD `Cargo.toml` 同款；`write_file_inner(path, content, encoding)` 保编码回写 |
| 忽略规则 | 用**已有 git2** `is_path_ignored()` | 不新增依赖 |
| 删除语义 | **系统回收站**（`trash` crate，失败再退永久删除） | SoloMD `commands.rs:344` 注释记录了 #112：旧 `unlink` 让用户永久丢过文件 |
| 文件变更 | `notify` + `notify-debouncer-mini` | 同 SoloMD；用于外部改动提示与树刷新 |
| OFV | **全量移植**（27 插件），不引 `@open-file-viewer/*` 依赖 | 用户口径；源码 MIT，可逐文件对照移植 |

---

## 4. 架构

### 4.1 目录

```
src/knowledge/
  KnowledgeWorkbench.vue        单面板（listPanel === detailPanel）
                               = PanelShell（#switcher 放当前文件/面包屑，#actions 放切换知识库·刷新）
                                 + 内部 SplitPane：左 FileTree / 右 编辑器或预览
  FileTree.vue                  树（懒加载、右键、内联新建/重命名、拖放、删除撤销）
  FileTreeNode.vue              树节点（递归）
  SwitchKnowledgeDialog.vue     根切换（复用「切换仓库」形态）
  editor/                       CM6 live-preview 栈（照 SoloMD `src/lib/cm-*.ts` 移植，MIT：文件头标注来源）
    engine.ts                   EditorEngine 缝隙（load/getMarkdown/on('change')/destroy）——为将来换内核留口
    live-preview.ts             HighlightStyle + 隐藏标记符的 ViewPlugin（≈ `cm-live-preview.ts` 248 行）
    live-blocks.ts              块级 widget：表格 / 公式 / mermaid / 图片（≈ `cm-live-blocks.ts` 1246 行）
    live-render.ts              行内 widget：列表点 / 分隔线 / 待办（≈ `cm-live-render.ts` 833 行）
    ime-guard.ts                组字冻结守卫（≈ `cm-ime-guard.ts` 128 行）★ 中文关键
    cjk-emphasis.ts             CJK 强调解析（≈ `cm-cjk-emphasis.ts` 148 行）
    table-editor.vue            表格弹窗编辑器（≈ `TableEditor.vue` 430 行）
    formula-editor.vue          公式弹窗编辑器（≈ `FormulaEditor.vue` 403 行）
    theme.css                   编辑器变量 → 我们 token 的映射
    toolbar/                    复用 IssueCreateDialog 的 12 键 Octicon 工具条
    assets/katex/               KaTeX 字体（woff2 子集，OFL 1.1，必须随包）
  preview/
    viewer.ts                   容器状态机（loading/rendered/error/unsupported）
    registry.ts                 扩展名 + magic bytes 判定 → plugin（27 个）
    shared/                     与编辑器共用的 mermaid / katex / prism 渲染
    plugins/*.ts                各格式渲染器（OFV 蓝图逐文件对照）
src-tauri/src/kb.rs             文件系统命令（沙箱 + 编码 + 回收站）
```

### 4.2 Rust 命令面

| 命令 | 入参 | 出参 | 备注 |
|---|---|---|---|
| `kb_list_dir` | root, rel, showIgnored | `Entry[]{name,rel,kind,size,mtimeMs,ignored,binary}` | 懒加载一层；`.git`/`node_modules`/`target`/`dist` 默认隐藏 |
| `kb_read_bytes` | root, rel | `tauri::ipc::Response`（原始字节） | 预览用；超阈值 → Err（引导系统打开） |
| `kb_read_text` | root, rel | `{text,encoding,bom,eol,size,mtimeMs}` | `chardetng` 探测 + `encoding_rs` 解码 |
| `kb_stat` | root, rel | `{exists,kind,size,mtimeMs}` | 外部改动检测 |
| `kb_write_text` | root, rel, text, encoding, bom, expectedMtimeMs | `{mtimeMs}` | **保编码回写**；mtime 不符 → 冲突错 |
| `kb_create` / `kb_rename` / `kb_move` / `kb_delete` | … | — | 管理操作（删除走回收站） |

**「用默认程序打开」与「在访达中显示」不走自建命令**：用仓库已有的 `tauri-plugin-opener`（`openPath` / `revealItemInDir`）。
⚠️ 现状 `src-tauri/capabilities/default.json` 只有 `opener:default`，而该默认集 = `allow-open-url` + `allow-reveal-item-in-dir`
+ `allow-default-urls`，**不含 `open_path`** → 需补 **`opener:allow-open-path`**（已从
`src-tauri/gen/schemas/acl-manifests.json` 确认权限名与命令映射；若该命令带路径作用域要求，实现时按 ACL scope 配）。

**沙箱**：统一 `resolve_in_root(root, rel)` → canonicalize + 前缀校验，拒 `..`／绝对路径／符号链接逃逸。
**根持久化**：一期 localStorage（与 `repo.ts` 的 `recentRepos` 同构），需要多根时再进 app.db。

---

## 5. 中文与离线问题清单（逐条：问题 → 修法 → 出处）

1. **输入法组字被吞**（"吃字"）：编辑期重建 DOM 会打断组字。
   修法：muya 路线看 `composeHandler` 是否覆盖我们场景；CM6 路线照 `cm-ime-guard.ts` 的冻结策略。
   出处：muya `block/content/tableCell/__tests__/composeHandler.spec.ts`（空单元格 ZWSP）、SoloMD issue #108。
   **必须实机验证**（macOS 拼音输入法连打）。
2. **文件编码**：中文遗留文件多为 GBK/GB18030（港澳台 BIG5、日韩 Shift-JIS/EUC-KR）。
   修法：Rust `chardetng` + `encoding_rs`，读回 `{text,encoding,bom}`，**写回按原编码**。
   出处：SoloMD `commands.rs:217`；OFV 的 JS 侧只覆盖 UTF-8→gb18030→gbk 且不回写（`plugins/utils.ts:109-126`）。
3. **PDF 中文乱码/白页**：缺 cmaps（CID→Unicode）与标准字体。
   修法：`pdfjs-dist` 的 `cmaps/`、`standard_fonts/`、`wasm/` + worker **全部本地化**并显式指定。
   出处：OFV `plugins/pdf.ts:189/191/991` 默认指向 jsdelivr——离线即失效。
4. **中文紧邻强调符**：`**粗体**中文` 类边界解析。
   修法：`markdown-it-cjk-friendly`（SoloMD 同款）；muya 侧核对其 lexer 对 CJK 的处理。
5. **中英混排宽度**：表格对齐/序号/光标定位按东亚宽度计算 → `get-east-asian-width`（SoloMD 同款）。
6. **docx 中文字体**：文档内写宋体/黑体/仿宋，WebView 无此字体 → 中文族映射表 + CSS 覆写（OFV 未处理）。
7. **中文文件名排序**：`localeCompare("zh-Hans-CN")`；路径全程 Rust `PathBuf`，不经 URL 编码层。
8. **字体策略（已定）**：界面 / 正文 / 代码一律**系统字体栈**（`-apple-system, "PingFang SC", "Microsoft YaHei"` + `SF Mono / Menlo / Consolas`），
   **不打包 UI 拉丁字库**（Open Sans 那类既无 CJK 字形，中文场景也用不上）；
   **唯一例外：KaTeX 数学字体必须随包**——它靠 `@font-face` 排版，缺字体公式会错乱（三条硬需求之一不能省）；
   只发 `woff2` 子集，OFL 1.1（保留字体名、不得单独售卖），在 `THIRD-PARTY.md` 记账。
9. **PlantUML 远程依赖**：muya 默认 `plantumlServer: https://www.plantuml.com/plantuml`（`config/index.ts:333`）。
   修法：**离线场景关闭 PlantUML**，或改配本地渲染服务；默认关闭并记入已知限制。
10. **GIS 在线底图**：OFV `gis.ts:31` 引 leaflet CDN 样式、`:129` 用 OSM 瓦片。
    修法：leaflet CSS 本地化；瓦片**默认关闭**，仅本地矢量要素渲染（离线）；需要在线底图时作为显式开关并标注。
11. **OFV 其它隐式远程**：`markdownToHtml` 类导出路径内嵌 CDN（muya 侧）、`webfontloader` 使用点需核。
    修法：移植时逐文件 grep `http(s)://` 清零后再合入。

---

## 6. 实施顺序（不分期砍功能，只按依赖排先后）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0 spike（主路线验证）** | 在 Tauri 真机里挂 **B（CM6 live-preview，照 SoloMD 最小实现）**，跑验收清单：<br>① 中文拼音连打（长句 / 候选窗 / 标点 / 中英混排）② Mermaid 围栏 ③ KaTeX 行内+块级+错误公式 ④ 表格 widget + 弹窗编辑<br>⑤ 打开真实中文长 md（≥200 行）的输入与滚动延迟 ⑥ 主题映射到我们 token 后 dark/light 观感<br>⑦ 断网可用性 ⑧ `vite build` 后 chunk 体积 ⑨ **md 往返保真**（打开→不改→保存，diff 必须为空） | ①③⑦⑨ 任一不过 → **回退备选 A（muya）**并把证据写进台账；全过 → 主线锁定 B，录屏/截图留证 |
| S1 骨架 | Rust `kb_*`（list/read/stat）+ 根切换 + 懒加载树 + 只读预览（文本/图片）+ 「用默认程序打开 / 在访达中显示」 | 树形态逐项对 VS Code + `pnpm gate` 绿 |
| S2 编辑 | **仅 Markdown**：CM6 栈移植（live-preview + 块级 widget + IME 守卫 + CJK 强调）+ 表格/公式弹窗 + 工具条 + `kb_write_text`（保编码）+ 冲突检测 | 中文输入法实机 + Mermaid/KaTeX 实机 + **往返 diff 为空** + 保存后编码不变 |
| S3 预览全量 | 27 个插件逐个移植（自简至重：文本/代码 → 图片 → PDF → 压缩包/邮件/OFD → Office 系 → 电子书/绘图/XMind → 音频视频 → 3D/CAD/GIS），每格式含 PDF 本地资源化与离线 grep 清零；**全部只读** | **每格式各一张实机截图 + 中文样本实测** |
| S4 管理 | 新建/重命名/删除（回收站）/移动（含撤销式移动）/拖拽/多选 | 每操作实机验证 |
| S5 增强 | ⌘P 快速打开、全文搜索（照 MarkText sidebar）、TOC、`notify` 刷新、面包屑、键盘导航 | 实机 + 对照表 |

---

## 7. 风险与待实测（不得按印象宣称完成）

1. **两引擎在真机上的表现均未实测**（这是 S0 的唯一目的）：muya 只在 Chromium（MarkText/Electron）验证过，
   而 SoloMD 的注释显示它曾为 Windows 备纯 textarea 兜底 → CM6 live-preview 在 WebView2 也有坑；macOS WKWebView 两边都没人验过。
2. 若选 muya：其 **md 往返保真**需在我们真实文件上验（它有往返测试，但冷门语法仍可能漂移）；
   若选 SoloMD 栈：**移植 ≠ 复制**，5,500 行的边界情况要自己接（其表格/公式是弹窗式编辑，观感弱于 muya）。
3. CM6 路线的 **Windows textarea 兜底**（SoloMD 注释透露）说明 WebView2 上 live-preview 可能不可靠——若回退到 B，需重估。
4. OFV 各格式的**依赖体积**（three / vega 级 / CAD wasm）与打包方式（前端 bundle vs Tauri `resources`）。
5. 大目录（≥10 万文件）懒加载树的性能。
6. 新依赖与门禁（ESLint flat / vue-tsc / Clippy / Vitest）的兼容。
7. 欠 VS Code Explorer 实机截图（§2.1）。

---

## 8. 任务台账（与 `TASK.md` 同编号）

- **T0** spike（**主路线验证**）：在真机挂 B（CM6 live-preview，照 SoloMD 最小实现）跑九项清单；①③⑦⑨ 任一不过 → 回退 muya 并把证据写进台账
- **T1** Rust 文件系统层（`kb_*` + 沙箱 + 编码探测/回写）+ 单测
- **T2** 工作区接线（workspaces 顺序：projects 右侧；**单面板** `knowledge.workbench` + panel-types + EditorIcon + 两语 i18n + `gotoKnowledge`/⌘5）
- **T3** 根切换对话框 + 最近列表 + 根失效守卫
- **T4** 文件树 UI（VS Code 度量 + SoloMD 骨架：懒加载/右键/内联编辑/删除撤销；**面板内部**用 `SplitPane` 与编辑器分栏）
- **T5** 预览器骨架（容器状态机 + 注册表 + 文本/图片 + **「用默认程序打开」/「在访达中显示」动作**，含 `opener:allow-open-path` 能力补充）
- **T6** 编辑器接入（**仅 Markdown**：SoloMD CM6 栈移植 + 表格/公式弹窗 + 主题 token 映射 + KaTeX 字体随包 + Octicon 工具条）
- **T7** 保存链路（保编码 + mtime 冲突检测 + ⌘S）
- **T9 已实现（含多选与拖拽移动）**：多选 = 单击/⌘/Shift（按可见行）/Esc/⌘A；批量删除/复制/剪切/移动到…（文案带数量）；拖拽移动**用手势事件而非 HTML5 拖放**（取证 SoloMD `useTreeDrag.ts`：Tauri 原生拖放会吞掉页面内拖拽）——落点判定/插入线/自动展开/撤销见 `src/knowledge/tree-drag.ts`、`tests/kb-tree-drag.test.ts`。
- **T8** OFV 全量预览移植（27 插件，按 §6-S3 顺序；只读；含 PDF 本地资源化、GIS/PlantUML 离线降级）
- **T9** 管理操作（新建/重命名/删除到回收站/移动/拖拽/多选）
- **T10** 增强（⌘P / 全文搜索 / TOC / watcher / 面包屑 / 键盘导航）
- **T11** R3 形态验证与逐项对照表（每阶段各一次）
- **T12** 致谢与第三方许可落地：README（中英）「致谢」小节 + 根目录 `THIRD-PARTY.md`（事实源 = §10）
- **T13** 「打开方式」设置（用户 2026-09-16 追加，含一处**已实证的 bug**）：
  1. **设置项**：Settings 面板新增「打开方式」段——默认应用（留空 = 系统默认）+ 可选按扩展名覆盖；
     值为**应用名**（macOS `open -a <名>` 语义，Windows/Linux 为可执行文件路径），
     选择用原生选择器（macOS 选 `.app`、Windows 选 `.exe`）或直接输入应用名。
     存储沿用 `settings` store + localStorage（与 `terminalShell` 同构）。
  2. **必须自建 Rust 命令**（不能在能力层修）：`tauri-plugin-opener` 的 `open_path` 在命令内部
     **强制 ACL scope 校验**（`commands.rs:65` → `scope.rs:139` `fs_scope.is_allowed(path) && …`），
     而 Tauri 的 fs scope 是**编译期静态**配置、且**空 allow 列表 = 全拒**（`tauri/src/scope/fs.rs:419-446`：
     `is_allowed` 无 allow pattern 即 false）。用户自选的知识库根无法表达成静态 scope →
     **现状「用默认程序打开」会拿到 `ForbiddenPath`（已实证，非推测）**。
     做法：新增 `kb_open_external(root, rel, with_app)` —— 复用 `resolve_in_root` 根沙箱 +
     应用白名单（只允许设置里登记过的 app），再在 Rust 侧调 `OpenerExt::open_path(path, with)`
     （Rust 侧无 ACL 限制）；「在文件管理器中显示」不受影响（`reveal_item_in_dir` 无 scope 校验，实测其命令实现无校验）。
  3. **预览头按钮改走该命令**并实机验证（当前实现在真机上必然失败）。
  4. 验收：设置项与预览头按钮联动（设了应用 → 用它打开；未设 → 系统默认）；沙箱与白名单各有单测；门禁绿 + 实机截图。

---

## 9. 与现有工程的融合点（逐文件，已核对源码）

### 9.1 总览：走完全相同的现有通道，不引入第二套机制

知识库 = **第 5 个 workspace**。链路与现有四个工作区完全一致：
`workspaces.ts` 一条定义 → `registry.ts` 注册两个面板 → **布局由 `stores/workbench.ts` 按 `(listPanel, detailPanel)` 自动生成并持久化**
→ 面板头由 `PanelShell` 统一提供（Editor 类型切换 / 分栏 / 关闭）→ 页签与快捷键在 `App.vue` + `menu-defs.ts`。
**左树右预览天然就是"列表 + 详情"这一对**，所以布局、持久化、关闭重开都不用新写。

### 9.2 逐文件改动表

| 文件 | 现状 | 本次改动 | 约束 / 风险 |
|---|---|---|---|
| `src/workbench/workspaces.ts` | 4 条定义；projects 用 `listPanel === detailPanel` = 单面板 | 在 projects 之后插入 `knowledge`，**两个字段同填 `knowledge.workbench`**（照 projects） | 数组顺序 = 页签顺序；**不改任何字段结构** |
| `src/workbench/registry.ts` | `registerPanel(type, component, modes?)`；projects 只注册 `project.board` | **只注册 1 个** `knowledge.workbench`（无 modes） | **禁止 import 环**（`registry → panel → PanelShell → registry` 曾致 TDZ 白屏） |
| `src/workbench/panel-types.ts` | 8 个类型 / 5 个分类 / `icon` 联合类型 | 加 **1 个类型** + `editorCat.knowledge` 分类 + 新 Octicon 名 | `tests/panel-types.test.ts`：分类须在 `editorCategories` 内、图标必填、**分类表不得有空分类**（新分类被这 1 个面板占用即可） |
| `src/stores/workbench.ts` | `allowedPanels` = 全部 `panelTypes`；`defaultLayout()` 在 `listPanel === detailPanel` 时**返回单个叶子**；`canCloseLeaf()` 对根叶子返回 false | **零改动**（上一版计划里的 `defaultRatio` 方案随双面板一并作废） | 单面板 = 根叶子 → **不会被误关**；树宽属于面板内部状态，不进工作台布局 |
| `src/App.vue` | 页签 `v-for="w in workspaces"`；`⌘1/2/3/4` → `switchWorkspace`；`MenuActions` 里 `gotoIssues/Pulls/Projects/Tools` | 加 `gotoKnowledge()` + 快捷键；**Tauri 与浏览器两条路径都要加**（原生菜单 + webview keydown 兜底） | 现有键已占 ⌘1–⌘4，新增避让（建议 ⌘5，菜单项与页签同序） |
| `src/menu-defs.ts` | `MenuActions` 接口 + View 菜单四项 | 加 `gotoKnowledge()` 与菜单项 | 与 `native-menu.ts` 的 `toAccelerator()` 形式一致（`"⌘5"`） |
| `src/components/EditorIcon.vue` | `o.*` Octicon 路径表 | 补文件族：`file-directory-fill` / `file-directory-open-fill` / `file` / `file-code` / `markdown` / `new-file` / `new-folder` / `collapse-all` 等 | 铁律：路径从 `@primer/octicons` 抓取，**不得自绘或用文字符号顶替** |
| `src/i18n/{zh-CN,en-US}.ts` | 548 / 551 键 | 加 `workspace.knowledge`、`panelTitle.knowledge.workbench`、`editorCat.knowledge`、树与预览文案 | `scripts/check-i18n.mjs` 校验两语键齐 |
| `src/api.ts` | `invoke` 封装（`saveTextFile`、`repoInfo`…） | 加 `kb*` 封装；外部打开按 `open-url.ts` 同款写 `open-path.ts` | 浏览器预览态（非 Tauri）需兜底，不炸 |
| `src-tauri/src/lib.rs` | 命令注册表 | 注册 `kb_*` 命令（新模块 `kb.rs`） | 不动既有 `resolve()` / `storage_dir_of()` 约定 |
| `src-tauri/capabilities/default.json` | `opener:default` | 加 `opener:allow-open-path` | 已核 `gen/schemas/acl-manifests.json`：默认集不含 `open_path` |
| `src/styles.css` | token 表（字号五档 + `--icon-size`） | 需要时扩 token；muya 变量映射写在这里或 `editor/theme.css` | 禁裸像素字号；树与编辑器同档 |
| `src/panels/close-reopen.ts` | 两击关闭 / 立即重开（详情面板共用） | **不涉及**（知识库面板是根叶子，无关闭语义） | — |

### 9.3 面板内部布局（对照 projects 的单面板做法）

- **工作台布局层零改动**：`listPanel === detailPanel` 时 `defaultLayout()` 返回单个叶子，`canCloseLeaf()` 对根叶子返回 false
  → 知识库面板不会被类型切换器换掉、不会被拆开、不会被关掉（正是用户指出的"双面板会出问题"）。
- 树与编辑器的分栏在**面板内部**用既有 `SplitPane` 原语（它自带 `min` 比例，默认 0.15，窄左栏无需改组件）。
  初始宽度按 VS Code 侧栏实拍校准（≈280px 量级）；宽度值存面板自己的 localStorage 键，不进工作台布局 blob。
- 面板头复用 `PanelShell`：`#switcher` 放当前文件与面包屑，`#actions` 放「切换知识库 / 新建 / 刷新」等；
  `PanelShell` 的 Editor 类型下拉仍然存在（用户想把这个 pane 换成别的面板也可以，属既有能力，不额外限制）。

### 9.4 数据层关系（边界要清楚）

- **根与仓库解耦**：知识库根 = 用户选择的文件夹；**首次进入的建议值**取当前仓库工作目录（若有），之后两者独立，
  互不修改对方状态（切仓库不影响已选知识库根，反之亦然）。
- **不写 `.hivetask/`**：知识库只操作用户自己的文件——不碰 `hivetask.db`、journal、`app.db` 的仓库/项目登记表。
  根路径一期落 localStorage（与 `repo.ts` 的 `recentRepos` 同构），需要多根或跨设备时再进 app.db。
- **忽略规则**：若根位于某个 git 仓库内 → 用**已有 git2** `is_path_ignored()`；否则只按内置排除表
  （`.git` / `node_modules` / `target` / `dist` / `.DS_Store`）。
- 与 Issue/PR/看板三块**无数据交集**，互不影响。

### 9.5 复用清单（不新造轮子）

| 需要的东西 | 复用什么 | 备注 |
|---|---|---|
| 根切换对话框 | `RepoManager` 的形态（页签 + 列表 + 新增入口）与 `emit('close')` / `emit('select', path)` 契约 | 复用形态，不复制实现 |
| 文件夹选择 | `pick_repo` 已有的 dialog 通道（`pick_folder` + 一次性 channel） | 新增 `kb_pick_root` 同构，或参数化复用 |
| 右键菜单 / 抽屉 / 下拉 | `ActionMenu`（分组标题 + 危险项红字）/ `SideDrawer` / `DropdownMenu` | 树节点右键 = ActionMenu |
| 图标 | `EditorIcon`（Octicon 族） | 见 9.2 |
| 主题 | `styles.css` 的 token + muya 的 CSS 变量映射 | light/dark 双档 |
| 外部打开 | `open-url.ts` 的同款写法（Tauri 走插件、浏览器兜底） | 扩展为路径版 |
| Markdown 渲染 | **知识库内不用 `MarkdownView`**：预览态走编辑器自身（muya），避免同文件两种观感；`MarkdownView` 继续服务 Issue/PR 正文 | 这条是刻意的不复用，理由写在这里 |

### 9.6 红线（沿用 AGENTS.md 与项目既有教训）

1. 弹层祖先**不得** `overflow`（树里的右键菜单、扩展名筛选弹层会被裁掉）。
2. 图标一律 Octicon 抓取；字号禁裸像素（五档 token）；图标挂 `--icon-size`。
3. 面板类型必须先登记进 `panel-types.ts`（否则持久化布局被拒）。
4. 不得制造 import 环。
5. 门禁六步全绿 + **R3 形态验证**（`pnpm gate` 绿 ≠ 形态对）。

---

## 10. 参考项目与借鉴清单（README 致谢用）

> 用途：本节是未来 README「致谢 / Acknowledgements」与 `THIRD-PARTY.md` 的**唯一事实源**。
> 每新增一处借鉴都在此加行，并注明**借鉴形式**，便于许可合规审查与对外说明。

**借鉴形式四档**（措辞会直接用在 README 里）：

| 档 | 含义 |
|---|---|
| **依赖** | 作为 npm / crate 依赖直接使用（保留原许可与版权声明） |
| **逐文件对照移植** | 读其源码后在我们仓库重写：算法与结构照抄，代码落在我们自己的文件里 |
| **实现骨架借鉴** | 借用其组件/模块骨架与踩坑结论，按我们的 token 与规范改写 |
| **行为/度量参照** | 只参考行为清单与实测数值，不复制代码 |

| 项目 | 许可 | 借鉴形式 | 具体用了什么 | 在我们代码中的落点 |
|---|---|---|---|---|
| **MarkText / muya**<br>`marktext/marktext` → `@muyajs/core` | MIT | **评估未采用**（备选，留痕） | 评估结论：WYSIWYG 全内置（表格**就地**编辑、KaTeX+mhchem、Mermaid 等图表块、图片缩放、段落菜单），零 Electron/Node 依赖、CSS 变量可映射；未采用原因：md↔内部状态需往返（知识库文件是唯一真源）、85k 行外部引擎不可控、contenteditable 在 WKWebView 未验证。**保留为备选内核**（B 若在 S0 触硬门槛则回退到此） | —（若回退则落 `src/knowledge/editor/MuyaEngine.ts`） |
| ↑ 同上 | | 行为参照 | 侧栏树 / 全文搜索 / TOC 的交互形态 | 文件树（T4）、搜索与 TOC（T10） |
| **SoloMD**<br>`zhitongblog/solomd` | MIT | **逐文件对照移植**（编辑器栈 + 文件树）+ 借鉴 Rust 文件层做法 | 编辑器栈 `src/lib/cm-*.ts`（**live-preview、Mermaid/KaTeX 就地渲染、表格 widget、IME 冻结守卫、CJK 强调**，合计 5,455 行）与 `TableEditor.vue` 430 / `FormulaEditor.vue` 403；文件树骨架（懒加载、右键菜单、内联新建/重命名含 IME 守卫、拖放合法落点 + 撤销式移动、删除撤销窗口、扩展名筛选、根目录失效检测）；其注释记录的 Tauri `dragDropEnabled` 吞拖放坑；Rust 侧 `chardetng`+`encoding_rs` 保编码回写、`trash` 回收站、`notify` 监听 | `src/knowledge/editor/**`、`src/knowledge/FileTree.vue`、`src-tauri/src/kb.rs` |
| **KaTeX 字体** | OFL 1.1（代码 MIT） | **依赖资产**（必须随包） | 数学排版所需的 `@font-face` 字体（只发 woff2 子集）；保留字体名、不得单独售卖 | `src/knowledge/editor/assets/katex/` |
| ↑ 同上 | | 逐文件对照 | Rust 文件层做法：`chardetng` + `encoding_rs` **按原编码回写**、`trash` 回收站删除、`notify` 变更监听；CJK 处理（`markdown-it-cjk-friendly`、`get-east-asian-width`、`cm-cjk-emphasis`）；**若回退 CM6 路线**，其 `src/lib/cm-*.ts` 全栈为对照源 | `src-tauri/src/kb.rs`、编辑器 CJK 处理 |
| **Open File Viewer**<br>`xushanpei/open-file-viewer` | MIT | **逐文件对照移植**（不引依赖） | 预览蓝图：**27 个格式插件**、`detect`（扩展名/MIME 判定）、`viewer`（容器状态机与降级策略）、`office` 的 docx 版面回退算法；**逐条排除其默认 CDN**（PDF 的 cmaps/worker/字体、leaflet 样式与 OSM 瓦片）。**T8 已落地**：18 个插件覆盖其全格式面（逐格式对照见 `docs/kb-preview-formats.md`），其中 OFD / XPS / LRC / DXF 改为自研解析，`cad-webgl` 交互视图、WMF/EMF、PSD/HEIC/TIFF、字体元信息、加密文档口令为**明示不做**（非遗漏） | `src/knowledge/preview/registry.ts`、`src/knowledge/preview/plugins/*.ts` |
| **Visual Studio Code**<br>`microsoft/vscode` | MIT（代码） | **行为/度量参照** + **codicon 图标资产** | 侧栏度量（22px 行高、16px 箭头单元格、缩进步长 `workbench.tree.indent` 且与行高联动、1px 缩进线、16×16 图标）；行为清单（预览页签、多选、拖放、键盘导航、面包屑、行内重命名、过滤、git 状态角标）；**资源管理器头部四枚动作图标原路径**（新建文件 / 新建文件夹 / 刷新 / 折叠全部）取自 `@vscode/codicons@0.0.36`，该图标集许可为 **CC BY 4.0（Microsoft）**，需署名 | 文件树（T4）、页签条（T6 前）与 R3 对照表；图标落在 `EditorIcon.vue` 的 `c.*` 族 |
| **Vditor**<br>`Vanessa219/vditor` | MIT | **评估未采用**（留痕以免重复评估） | 曾评估其 IR（即时渲染）模式；因其为自带 DOM/CSS/工具栏/i18n 的整体件、图标自绘、按需资源默认走 unpkg 而放弃 | —（仅计划与台账留痕） |

**随包传递的第三方许可（`THIRD-PARTY.md` 需逐个列出）**：

- **许可性质先澄清**：**Apache-2.0 / MIT / SIL OFL 1.1 全部可商用**——义务是保留版权与许可原文、标明修改、
  字体不得单独售卖、OFL 保留字体名不得用于改版。本项目自身是 **AGPL-3.0-only**，比这些都严格，
  商用约束来自我们自己的许可，不来自这些组件。
- muya 自带字体：**Open Sans（Apache-2.0）**、**DejaVu Sans Mono（Bitstream Vera）**——包内已附 LICENSE。
  **建议不打包**（Open Sans 无 CJK 字形；改用系统字体栈，体积更小、中文观感更好、许可事项更少）= 零许可义务。
- KaTeX：**代码 MIT**（Khan Academy），**字体 SIL OFL 1.1**（Design Science + Khan Academy，含保留字体名）→ 可随包分发。
- **@vscode/codicons**（VS Code 图标集）：**CC BY 4.0**（Microsoft）——只用了 4 条路径（新建文件/新建文件夹/刷新/折叠全部），须在 README 致谢与 `THIRD-PARTY.md` 中署名，其余义务（保留署名、标明修改）在图标文件注释里已注。
- muya 运行时依赖（27 个：`snabbdom` / `katex` / `mermaid` / `prismjs` / `marked` / `turndown` / `dompurify` / `vega*` / `rxjs` / `underscore` / `flowchart.js` / `snapsvg` / `webfontloader` …），多为 MIT，逐个核后入表。
- OFV 蓝图涉及的库：`pdfjs-dist`(Apache-2.0)、`docx-preview`、`mammoth`、`xlsx`、`jszip`、`pako`、`prismjs`、`postal-mime`、`@kenjiuno/msgreader`、`heic2any`、`utif`、`ag-psd`、`hyparquet`、`hls.js`、`seek-bzip`、`xz-decompress`、`three`、`@mlightcad/*`、`leaflet` + `shpjs`/`@mapbox/togeojson`/`topojson-client`、`dompurify`。
  **T8 实际引入并逐个核对 license 后的清单**（`THIRD-PARTY.md` 为准）：pdfjs-dist(Apache-2.0)、docx-preview(Apache-2.0)、
  mammoth(BSD-2-Clause)、xlsx(Apache-2.0)、jszip(MIT OR GPL-3.0+，按 MIT 用)、pako(MIT AND Zlib)、prismjs(MIT)、
  postal-mime(MIT-0)、dompurify(MPL-2.0 OR Apache-2.0)、three(MIT)、leaflet(BSD-2-Clause)、shpjs(MIT)、
  @mapbox/togeojson(BSD-2-Clause)、topojson-client(ISC)、hls.js(Apache-2.0)、**@mlightcad/libredwg-web(GPL-3.0)**
  ——最后这项是全仓库唯一的强 copyleft 第三方件：已随包附许可全文 + NOTICE，依 AGPL-3.0 第 13 条结合分发；
  不想要时可只删 DWG 路径（DXF 为自研，不依赖它）。

**交付物（新增 T12）**：`README.md` / `README.zh-CN.md` 的「致谢」小节 + 仓库根 `THIRD-PARTY.md`，内容以本节为事实源。

**本节已按 T0 前的用户决策定稿（2026-09-16：主线 SoloMD / 不打包 UI 字库）**：
muya 行 = 「评估未采用（备选）」并保留完整评估结论；MarkText = 「行为参照」；SoloMD = 「逐文件对照移植」（编辑器栈 + 文件树 + Rust 做法）。
若 S0 触硬门槛回退到 muya，则把 muya 行改回「依赖」、SoloMD 编辑器栈部分降为「行为参照」——两种结果都已留痕，避免重复评估。
