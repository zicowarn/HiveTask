# 任务报告：T0 spike（CM6 主路线验证）

- 日期：2026-09-17
- 分支：`feat/pr-module`
- 依据：`docs/plan-knowledge-workspace.md` §6-S0（九项清单）+ §8-T0
- 状态：**硬门槛通过（主路线 B 确认）**——① 中文输入法 ② Mermaid ④ KaTeX 已由用户真机实测通过；
  ③⑤⑥ 未单独复验（③ 的静态证据已过）。真机截图另暴露并修掉了两个真问题（见 §2.1）

## 1. 已完成的验证

### ⑨ md 往返零失真 —— PASS

| 证据 | 内容 |
|---|---|
| `tests/kb-editor-roundtrip.test.ts`（4 条） | LF 源文本原样取回；列表符（`-`/`*`/`+`）、表格对齐符、行尾空格**不被归一化**；中文与全角标点不被改写 |
| CRLF 的分工（同测试） | CM6 内部按 `\n` 分行是本分行为，**写回由 Rust 按原 `eol` 还原**——该路径已有 Rust 单测 `keeps_utf8_bom_and_crlf` 守着字节相等。测试把这条分工固定下来，防止将来有人在 JS 侧"顺手"做换行转换 |

### ⑦ 离线无 CDN —— PASS

- 产物扫描：编辑器三个 chunk（`MarkdownEditor` / `katex` / `mermaid.core`）里的外部 URL **只有 XML 命名空间**
  （`www.w3.org/...`，是标识符不是请求）；唯一一处 `https://` 是 CodeMirror 自动链接功能在 `www.` 前补协议的字符串逻辑。
- **KaTeX 字体随包**：`dist/assets/KaTeX_*.woff2` 共 **19 个**（约 1.1 MB），由 `katex.css` 的 `url()` 经 Vite 打包进产物。
- 我们自己的源码（`src/knowledge/**`）无任何 http(s) 资源引用（仅注释里的出处链接）。

### ⑧ 产物体积 —— 发现并修掉一个真问题

**问题**：编辑器最初是**静态**引入的 → CM6 + markdown 解析器被塞进启动包，
主 chunk **1654 KB**（未压缩），不打开知识库的用户也要付这份代价。

**修法**：`KnowledgePreview` 用 `defineAsyncComponent` 按需加载编辑器。

**修后**（未压缩）：

| chunk | 大小 | 何时加载 |
|---|---|---|
| `index`（主包） | **877 KB**（−777 KB） | 启动 |
| `MarkdownEditor` | 760 KB | 打开 Markdown 文件时 |
| `mermaid.core` + 各图表类型 | 656 KB + 若干 | 首次遇到 ```mermaid |
| `katex` | 261 KB | 首次遇到公式 |

### 装饰器逻辑（T6 的风险点，先用单测锁住）—— 8 条 PASS

`tests/kb-editor-decorations.test.ts`：

- live-preview：光标在**其它行**时标题行的 `#` 被隐藏、光标**所在行**的记号保持显形（Typora 语义）；标题行拿到块级行装饰。
- 公式/图表：行内 `$…$` → KaTeX widget（非 display）；独行 `$$…$$` → display；**跨行 `$$` 块** → display；
  **代码块里的 `$` 不被识别**；```mermaid 围栏 → Mermaid widget（携带源码）；光标进入块内 → 回到源码。

**测试逼出的一个真实缺口**：原先只支持单行 `$$…$$`，**跨行块级公式不渲染**（而这是 Markdown 里最常见的写法）。
已补实现：扫描 `$$` 独占行的区间 → 闭合行 → 整段替换为 display 公式。

## 2. 真机验证结果（2026-09-17，用户实测）

| # | 项 | 结果 |
|---|---|---|
| ① | **中文输入法连打**（硬门槛） | ✅ **通过** —— 主路线 B（CM6 栈）**确认**，不触发 muya 回退 |
| ② | Mermaid 渲染 | ✅ 通过（截图中 `graph TD` 正常出图） |
| ④ | KaTeX 渲染 | ✅ 通过（行内与块级公式均正常） |
| ③ | 断网可用 | ⏳ 未单独复验（静态证据已 PASS：产物无外部资源） |
| ⑤ | 260 行长文性能 | ⏳ 未单独测量 |
| ⑥ | 明暗主题观感 | ⏳ 未单独确认 |

### 2.1 真机截图暴露的两个真问题（均已修）

**问题 A：编辑器只显示行号、正文一片空白。**
根因（jsdom 立刻复现）：`RangeError: Decorations that replace line breaks may not be specified via plugins`。
表格 / Mermaid 围栏 / 跨行 `$$` 公式都是**跨行替换**，而 CM6 规定这类替换必须用
`Decoration.replace({ block: true })`、覆盖**整行范围**，且**只能由 state facet（`EditorView.decorations`）提供**——
我原先把它们放在 ViewPlugin 的 decorations 里，于是抛错、正文不渲染。

**修法**：块级替换（表格 / Mermaid / 块级公式）统一移入 `mathAndDiagram()` 的 state facet，范围取整行；
ViewPlugin 只保留行内装饰（记号隐藏、圆点、待办、分隔线、行内公式）。

**问题 B：GFM 根本没开。** `markdown()` 默认基语言是 **CommonMark**，
表格/待办/删除线/自动链接都不存在（表格被解析成普通段落、待办没有 `Task` 节点、
`StrikethroughMark` 形同虚设）。改为 `markdown({ extensions: [GFM] })`（与 GitHub 一致）。

**新增能力**：表格 widget（真 `<table>`，列对齐按分隔行 `:` 解析，单元格走 markdown-it inline 渲染）。

### 2.2 新增的测试设施（本次的关键收获）

**jsdom 渲染测试**（`tests/kb-editor-render.test.ts`，文件头 `// @vitest-environment jsdom`）：
把真实扩展栈挂上 EditorView，断言 DOM 里**确实有内容**（正文文本、`<table>`、复选框、KaTeX DOM、Mermaid 容器）。
问题 A 就是它第一条命中的——**"装饰算得对"与"渲染出来不是空的"是两件事**，
前者用 decoration 单测覆盖，后者必须真渲染。这套设施让后续 T6/T8 的迭代不必每次都上真机。

### 2.3 复选框「状态反了」的误判（已澄清）

截图里 `- [ ] 未完成项` 显示为勾选、`- [x] 已完成项` 显示为空框，一度以为渲染反了。
核对文件内容后确认：**文件本身那时就是反的**——用户测试时点了两个复选框（验证切换）并 ⌘S 保存，
所以两项互换、mtime 落在我重启的时间窗内。**渲染逻辑正确**（编辑器如实渲染文件内容），
且这条线索顺带证明 **点击切换 + ⌘S 保编码回写** 的端到端链路可用。

## 2.4 T6 修订（用户第二轮截图反馈）

| 反馈 | 处置 | 说明 |
|---|---|---|
| 编辑器宽度没撑满 | 删掉 `.md { max-width: 760px }` | 该规则原属 markdown-it 预览，编辑器复用同一 class 被一起限制了；现铺满面板 |
| 四周 padding 应移除 | `.preview-body` 在编辑器激活时 `padding: 0; overflow: hidden` | 同时消掉**双滚动条**（外层滚动容器 + CM6 自身滚动） |
| 引用部分没有渲染 | 新增**图片 widget**（`editor/image.ts`） | `![alt](src)` 渲染成真 `<img>`；**本地相对路径经 `kb_read_bytes` 从知识库根读取 → object URL**（不绕过根沙箱、离线可用）；`http(s)`/`data:` 直连；加载失败显示文字提示（不伪造占位）。文档上下文（根 + 当前文件相对路径）经 CM6 **facet** 传入，不用模块级全局 |
| （随后）"过于紧凑" | 内容内边距回调为 `10px 24px 48px` | 见下：区分**外层白边**与**内容内边距**——前者归零（贴边铺满，同 VS Code/Typora），后者不该删（0 会让文字紧贴行号与右边缘，读起来发闷） |

图片路径解析为纯函数 `resolveImageRel(docRel, src)`（`./`、`../`、查询串/锚点都在前端归一化，
最终仍由后端沙箱复核），单测覆盖 5 种形态。

## 2.5 Markdown 命令入口（2026-09-17，用户设计确认后实施）

**前提澄清**：Mermaid 不需要菜单（样式本来就靠 `classDef` / `linkStyle` / `%%{init}%%` 语法，
Typora 也没给它做 UI）；需要"菜单协助"的是 **Markdown 写作**。用户随后确认落点：**工具条放在编辑器顶部
（文件信息那一行）+ 右键菜单配合**。

### 2.5.1 单一事实源

`src/components/markdown-tools.ts` —— 命令表（key / kind / icon / 文案键 / 快捷键 / 前缀后缀或插入文本）
+ 分组。**工具条、快捷键、右键菜单三处都从这里取**，`tests/markdown-tools.test.ts` 锁住契约：
key 唯一、图标与文案齐备、wrap 必须成对给前后缀、line 必须给行首标记、分组内 key 都存在且不重复、
Issue 编辑器键序不变，以及**快捷键避开本应用已占用键**（`⌘1..5` 工作区页签 / `⌘R` / `⌘O` / `⌘,` / `⌘⇧C` / `⌘⇧O`）。

### 2.5.2 三处入口

| 入口 | 实现 | 说明 |
|---|---|---|
| **面板头工具条** | `MarkdownToolbar.vue`（共享组件） | 落在文件信息行**中部**（用户指定位置），组间竖线分隔、超出横向滚动；IssueCreateDialog 也改用它（原 12 键本地定义删除，杜绝两份漂移） |
| **文件级动作** | 收进该行右端的 **⋯ 菜单**（ActionMenu，`size="ui"`） | 「用默认程序打开」「在文件管理器中显示」从两个按钮折叠为菜单项——**腾出行中部给工具条**，也避免这行再次出现宽度挤压（历史上「刷新」按钮文字被挤成两行就发生在这一行） |
| **右键菜单** | CM6 `contextmenu` → 宿主渲染 `ActionMenu`（新增**坐标锚点模式**） | `ActionMenu` 新增 `anchor` prop：给定坐标即不渲染触发器、菜单以 `position: fixed` 落在指针处，Esc/外点/选中都走 `@close` 让宿主清空锚点。菜单项来自同一命令表（分组：格式 / 段落 / 插入 / 编辑），右侧显示快捷键角标 |

命令实现（`src/knowledge/editor/commands.ts`）：包裹选区（空选区插占位并选中占位内容）、行首前缀、
整块插入（`$1` 标记光标落点；光标不在行首时先补换行，避免把表格塞进当前行中间）——
全部走 CM6 事务，**天然进撤销历史**。

快捷键：`⌘B/⌘I/⌘K`、`⌘⇧K`（行内代码）、`⌥⌘Q/U/O/X`（引用/无序/有序/任务）、`⌥⌘B`（公式块）、`⌥⌘T`（表格）、
**`⌥⌘1..6`（标题级别）**——标题用这套是因为 `⌘1..5` 被工作区页签占用、`⌃1..6` 被 macOS 切换桌面占用。

### 2.5.3 验证

- **测试**：`markdown-tools.test.ts`（7 条契约）+ `markdown-commands.test.ts`（8 条真实行为：包裹/前缀/插入/撤销/未知 key）
  + `kb-editor-context-menu.test.ts`（3 条：右键事件带坐标、ActionMenu 锚点模式不渲染触发器且落点正确、选中后抛 pick 并通知关闭）。
  为此 `vitest.config.ts` 挂上了 `@vitejs/plugin-vue`（组件级测试需要 SFC 编译）。
- **真机截图**：工具条在文件信息行中部（14 个按钮、4 组）、⋯ 在右端、表格/待办/Mermaid 同时正常。
- 门禁全绿：**Vitest 98**（19 文件）+ cargo 66。

### 2.5.4 大纲 / 源码模式 / 查找（用户追问后补做）

用户问"这三项工具栏没有？"。先澄清类别，再按类别落位：

| 项 | 类别 | 落位与实现 |
|---|---|---|
| **大纲** | 视图（布局） | 头部右端**开关图标**（`o.list-ordered`）→ 打开后编辑器右侧出现**第三栏**（嵌套 `SplitPane`，比例持久化）。数据来自 CM6 语法树的标题扫描（`editor/outline.ts`：ATX 与 Setext 都认；**代码块里的 `#` 不算标题**），支持点击跳转（`goToLine`，滚动到行首并聚焦）与**光标跟随高亮当前章节**（`activeOutlineIndex`：最后一个起始行 ≤ 光标行的标题） |
| **源码模式** | 视图模式 | 头部开关（`o.md-code`）→ 一个 `Compartment` 挂/卸实时渲染装饰（live-preview 与公式/图表 widget），**缓冲仍是同一份 Markdown**，语法着色保留 |
| **查找/替换** | 就地浮层 | `@codemirror/search` 的 `search({ top: true })`（浮在编辑器顶部，VS Code 惯例），`⌘F` 打开；头部也给一个入口图标（`o.search`） |

三个开关都记进 `localStorage`（`hivetask.kb.view`：outlineOpen / livePreview / editorRatio），重启保持。

**测试**：`kb-outline.test.ts` 8 条（标题提取、代码块排除、去掉首尾记号、当前章节判定）+ 头部测试扩到 4 条
（三个视图开关就位、大纲默认关闭、打开后渲染条目）+ 源码模式 1 条（卸装饰后表格回到源码文本）。

### 2.5.4b 查找条自绘 + 按钮文案（用户第二轮反馈）

| 反馈 | 处置 |
|---|---|
| 查找条**过于简陋、与整体风格不一致** | CM6 的默认面板是裸 `input` + 系统按钮 + **英文硬编码**（`next/previous/match case/...`），与我们的 token / i18n 规范冲突。改为**只借用 CM6 的搜索状态与匹配高亮**（`search()` 扩展 + `setSearchQuery`/`findNext`/…），**界面自绘** `KnowledgeFindBar.vue`：我们的输入框/图标按钮/描边与圆角、i18n 文案、`Aa`/`.*`/`W` 三个开关（选中态用 accent）、命中计数 `3/12`、无结果显示「无结果」、正则非法时输入框转危险色；替换行按需展开（默认收起，省高度）。查找条叠在**编辑区右上**（不占布局高度），`⌘F` 打开、`Esc` 关闭并**撤掉高亮**（避免"看不见的命中"残留） |
| 「用默认程序打开」措辞 | 两次修正后的最终文案：**「默认应用打开」**（用户定案）。设置项描述与英文目录同步（英文为 "Open in default app"） |

门禁全绿：**Vitest 112**（21 文件）+ cargo 66。

### 2.5.4c 查找导航修正 + 一个更深的发现（用户第三轮反馈）

| 反馈 | 根因（源码为证） | 处置 |
|---|---|---|
| 上/下一个的**图标方向不对** | 我借用了 `chevron-down`（上一个）与 `chevron-right`（下一个）——方向语义混乱 | 补 Octicon `chevron-up` 原路径；上一个 = **上箭头**、下一个 = **下箭头**（VS Code 同款语义） |
| 点「上一个/下一个」**弹出底部的原始搜索面板**，而不是执行搜索 | CM6 的 `searchCommand` 包装器：`state && state.query.spec.valid ? f(view, state) : openSearchPanel(view)`——**无有效查询时会去打开它自带的默认面板**。点按钮时输入框还是空的，于是底部弹出 | **导航自实现**（`SearchCursor` 收集命中 → 按"起点语义"选目标 → 选中并滚到中线），彻底不碰会开面板的命令；替换类仍用 CM6（正则组引用 `$1` 需要它的 `getReplacement`），但**先自检有效性**。查找条侧：查询为空时点导航只把焦点放回输入框。移除 `searchKeymap`（它的 `findNext` 同样会开面板），改绑 `F3/⇧F3/⌘G/⇧⌘G` 到自实现导航 |
| （连带修）起点语义 | — | 光标停在文档开头时，第一次「下一个」应命中**第一处**（对齐 VS Code）：当前正好选中某命中时才跳到它的下一个，否则取"从光标起的第一个命中"；到底/到顶**环绕** |

**⚠️ 顺带查出一个更深的真问题（不是测试问题，是产品问题）**：

并行跑测试时装饰相关用例**间歇性失败**。查因发现根因在 `syntaxTree(state)`——
CM6 的语法树是**后台分块解析**的，`syntaxTree()` 返回的是**当前（可能未解析完）**的树。
我们的装饰构建、大纲提取都是"一次性读全量节点"，拿到半截树就会**随机漏渲染**
（表格/待办/公式/Mermaid/标题），真机上也可能出现"首次打开少渲染几处"。

**修法**：新增 `editor/tree.ts` 的 `fullSyntaxTree(state)` = `ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state)`，
五处装饰/大纲/图片/表格构建全部改用它。改后**连跑四次全量测试 115 全绿**（此前每次跑都有 2–3 条随机失败）。

### 2.5.5 字数统计 + 粘贴/拖放插图（已实现）

| 项 | 实现 |
|---|---|
| **字数统计** | `editor/stats.ts`：`chars` = **非空白字符数**（汉字/字母/数字/标点各算一个），`words` = **拉丁词数**（`don't`、`well-known` 算一个词）。编辑器在文档变化时上报 → store → **状态栏格**显示「1,234 字 · 56 词」；**纯中文文档词数为 0 时只显示字数**（不显示「0 词」这种噪音）。按码点计数，emoji 算 1 个字符 |
| **粘贴/拖放插图** | 剪贴板或拖入的 `image/*` → `kb_write_bytes`（Rust：根沙箱 + **自动建父目录** + 原子写 + **自带 base64 解码**，30 行有单测，不为这一处引 crate）→ 插入 `![pasted-….png](assets/pasted-….png)`。落点是**文档同级的 `assets/`**（`docs/note.md` → `docs/assets/x.png`），引用**不依赖文档深度**、不会出现一串 `../`；文件名 `pasted-YYYYMMDD-HHMMSS.ext`，**同名自动加序号**（只对"已存在"重试，其它错误直接报）；成功后 toast 回执、失败给可读原因。拖放按**落点坐标**插入，粘贴按光标插入 |

**Rust 侧**：`kb_write_bytes(root, rel, base64)` + `decode_base64`（自实现，标准字母表 + 填充 + 允许折行），
单测覆盖解码边界与「建父目录 / 覆盖写 / 越界拒绝」。kb 模块测试 12 条。

**前端测试**：`kb-stats.test.ts` 7 条（口径：空白不计、拉丁词规则、中英混排、emoji 按码点、空文档）
+ `kb-assets.test.ts` 6 条（同级 assets 落点、引用格式、时间戳命名与序号、MIME 优先的扩展名、只挑 image/*）
+ 状态栏来源的 stats 上报 1 条。

### 2.5.5b 树度量收紧（用户口径）

| 项 | 改前 | 改后 | 说明 |
|---|---|---|---|
| 行首基准缩进 | **18px**（2px 行内边距 + 16px 箭头格，照 VS Code 实测） | **8px** | ③适配：我们的树栏只有 ≈294px，18px 空白占比过大；收到 8px 后标签多出 10px，且与既有 8px 缩进步长同源 |
| 每级缩进 | 8px | 8px（不变） | 与 `workbench.tree.indent` 默认值一致 |
| 箭头 3px 位移 | `translate(3px)`（VS Code 实测值） | **去掉** | 有它时箭头在 21px、参考线在 18px，**两者差 3px**（错位）；去掉后箭头与参考线同 x |
| 缩进参考线 | `left: 18px`，宽 `(depth-1)*8+1` | `left: 8px`，宽 `depth*8` | 与祖先箭头列严格同 x |
| 树头左右内边距 | 左 12 / 右 8（不对称） | **左右各 8** | 与行首基准对齐 |
| 列表顶部间隔 | 0 | **4px**（底部仍 8px） | 用户口径：表头与首行之间留呼吸 |

`tests/kb-tree-metrics.test.ts`（3 条）锁住"组件算出的样式值"（jsdom 无布局引擎，故断言设计意图这一层）；
观感由实机截图确认。

### 2.5.5c 树右键菜单按参照项目补齐 + 文件图标（用户提问后补做）

**用户指出：菜单该参照的是我们实际借鉴的两个项目**（SoloMD / MarkText），不是 VS Code。
我先前凭印象列项，**没做 R1 取证**——这里补上，并留下对照表（R7）。

| 参照 | 菜单顺序与分组（源码实测） |
|---|---|
| **SoloMD** `FileTree.vue:1220-1258` | 新建文件 / 新建文件夹（**仅根或目录**）→ 分隔 → 重命名 / **移动到…** / 删除（危险）/ 复制路径 / 复制相对路径 / 复制 Git URL（仅文件）→ 分开 → 在访达中显示 |
| **MarkText** `contextMenu/sideBar/index.ts` | 新建文件 / 新建目录 → 分隔 → **复制 / 剪切 / 粘贴**（粘贴按剪贴板状态启用）→ 分隔 → 重命名 / 移到废纸篓 → 分隔 → 在文件夹中显示 |

**实现后的我们**（分组：文件 / 剪贴板 / 管理 + 无标题的路径组）：

`在编辑器中打开 · 默认应用打开` → `新建文件… · 新建文件夹…` → `复制 · 剪切 · 粘贴` → `重命名… · 移动到… · 删除` → `复制路径 · 复制相对路径 · 在文件管理器中显示`

- **③适配标注**：头两项（在编辑器中打开 / 默认应用打开）是**我们的差异**——两个参照项目"单击即打开"，不需要菜单项；我们的单击是选中/预览，所以必须给菜单入口。
- **粘贴**：无可粘贴内容时**不出现**（MarkText 是置灰；我们选择不出现，避免"点了没反应"的空控件），有内容时行尾显示待粘贴文件名角标。
- **剪切/复制/粘贴/移动到** 是新能力：Rust 新增 `kb_copy`（目录递归）/ `kb_move`（跨目录，`rename` 失败退回复制+删除），
  目标校验统一在 `check_destination`（不得覆盖、不得移进自身子树、目标目录必须存在、根沙箱）；
  `移动到…` 用原生目录选择器，**前端先换算根内相对路径**，不在根内直接拒绝并提示。

**文件图标**（用户问"有没有可借鉴的资源"）：

| 方案 | 结论 |
|---|---|
| **MarkText 的 `@marktext/file-icons`** | npm 有（**MIT**，解包 **632KB**，2022 年后停更，"atom file icons" 移植）→ 能给 per-language **彩色**图标；但它是成套彩色图标字体，与本仓库"图标一律走 EditorIcon 的 Octicon 族"冲突，且要随包带字体 |
| **SoloMD 的做法** | 直接用 emoji 字面量（📄📁✎↪🗑📋🔍）→ **违反图标铁律，不能照搬** |
| **本次采用** | **Octicon 类别映射**（零新依赖）：Markdown `o.markdown`、代码 `o.file-code`、媒体 `o.file-media`、压缩 `o.file-zip`、二进制 `o.file-binary`、数据 `o.layout-table`、其余 `o.file`；目录按开合切换、符号链接单列。补了 4 条 Octicon 原路径（file-code/media/zip/binary）+ `o.paste`/`o.copy`/`o.arrow-right`；**剪切图标自绘**（Octicons 里没有剪刀，符合"平台没有才自绘"的规范） |

MarkText 的一条踩坑也记在这里备用：其 `fileIconClass.ts` 注释指出**按扩展名匹配必须优先于整名匹配**，
否则 `Dockerfile-Notes.md` 会被当成 Dockerfile 图标（其 #4890）——我们的 `extensionOf()` 已按此实现（前导点不算扩展名）。

**测试**：树菜单项契约扩到 5 条（文件/目录动作集差异、分组顺序、粘贴按剪贴板条件出现）+ 文件图标分类 3 条；
Rust kb 模块 16 条（新增 copy/move：递归复制、不覆盖、不进自身子树、跨目录移动、越界拒绝）。

### 2.5.5d 页签右键菜单（VS Code 编辑器页签菜单的对照与实现）

用户在图上给出 **VS Code 的页签右键菜单**，要求逐项分析可实现性。结论（19 项）：

| VS Code 项 | 我们 | 说明 |
|---|---|---|
| Close / Close Others / Close to the Right / Close All / **Close Saved** | ✅ 已实现 | 关闭族进 store；**Close Saved 依赖 per-tab 脏标记** |
| Copy Path / Copy Relative Path | ✅ 已实现 | 复用树菜单同款能力（Tauri 下走 Clipboard API + toast） |
| Reveal in Finder | ✅ 已实现 | 既有 `reveal_item_in_dir` |
| **Reveal in Explorer View** | ✅ 已实现 | 「在文件树中显示」：展开全部祖先 → 选中 → `scrollIntoView` + 900ms 高亮 |
| **Pin** | ✅ 已实现 | 固定组排在最前；批量关闭**跳过固定页签**；取消固定回到"固定组之后第一位"（VS Code 语义）；页签显示图钉（`o.pin` 旋转 45°）与未保存圆点 |
| Reopen Editor With… | ✅ 简化实现 | 映射为我们的三选：**以实时渲染打开 / 以源码模式打开 / 默认应用打开**（③适配：VS Code 是"用哪个编辑器"） |
| Git: View File History | 🟡 可做待做 | `git::history(repo, limit)` **不支持路径过滤**（已核对签名）→ 需新命令 `file_history`（revwalk + 逐提交 diff pathspec） |
| Find File References | 🟡 归 T10 | 与"全文搜索"是同一件事（跨文件检索文件名/引用） |
| Split Right / Split & Move | ❌ 架构级 | 文件级分栏要求**每个面板各持一份"打开文件"状态**，我们的 store 是全局单例；外层分栏能力已有（面板头 split 按钮）。改造属架构级，待排期 |
| Move / Copy into New Window | ❌ 架构级 | 需多窗口（当前 appdb 与工作台按单窗口设计） |
| Share / Add File to Chat | ❌ 无此能力 | Live Share / Copilot 专属，不造假 |
| Copy Breadcrumbs Path | ❌ 重复 | 我们没有面包屑 UI，与"复制相对路径"等价 |

**顺带修掉一个真实的数据丢失**：此前切换页签时 `load()` 直接覆盖缓冲，
**未保存的编辑会被静默丢弃**。现在按 VS Code 口径给**每个页签各持一份缓冲**
（`store.buffers`：文本 + 落盘元信息 + 脏标记），切走前落盘到 store、切回时优先读缓冲；
`Close Saved`、未保存圆点、关闭前确认都建立在这份状态上。

**测试**：页签族 12 条（关闭族五种语义、固定顺序与取消固定的落点、关闭时清理缓冲、dirtyTabs）。
其中两条断言最初写错，暴露的是**实现没对齐 VS Code**（解固定后应回到固定组之后而非留在最前）——改的是实现，不是断言。

### 2.5.5e 两个真 bug：菜单位置错乱 / 树菜单不出现（用户实测截图）

**同一个根因（CSS 级联顺序）**：

```css
.am-menu--anchored { position: fixed; right: auto; z-index: 200; }   /* 写在前面 */
.am-menu { position: absolute; right: 0; top: calc(100% + 3px); }    /* 写在后面，同特异性 → 后者胜 */
```

锚点菜单实际退化成 `position: absolute`，按 `.am`（触发器包裹层）定位：

- **页签菜单** → 贴在页签条下方、"位置不对"（用户截图所示）；
- **树菜单** → 树在 `.pane { overflow: hidden }` 内，菜单被**裁掉** → 看起来"树没有菜单"
  （AGENTS.md 早就记过这类"弹层被 overflow 裁掉"的坑，这次又踩了一遍）。

**修法（两道保险）**：

1. **Teleport 到 body**（`<Teleport to="body" :disabled="!anchored">`）——彻底脱离祖先的 overflow 与层叠上下文；
2. **提高选择器特异性**：`.am-menu.am-menu--anchored`，不再依赖书写顺序。

**测试补强**（jsdom 不做级联计算，所以锁"挂到哪"这一层，而不是锁 `position` 值）：
`kb-editor-context-menu` 断言锚点菜单**不在宿组件内、而在 `document.body` 上**；
树菜单/页签菜单测试的查询同步改到 `document.body`，并在用例间清理残留菜单。

### 2.5.5f 树菜单被窗口下沿切掉 → 加"空间不足上翻"

用户实测第二张截图：点击**靠底部的文件**时，菜单向下伸展越出窗口，下半截看不见
（Teleport 已解决"被面板 overflow 裁剪"，但仍会越出**视口**）。

**修法**（菜单的标准行为，VS Code 同款）：锚点模式改为**先贴指针、量出尺寸、越界再调整**：

- 下方空间不足 → **向上翻**（`top = 指针 y - 菜单高`），仍不足则贴顶并保持 8px 边距；
- 右侧空间不足 → 左移收进（`left = 视口宽 - 边距 - 菜单宽`）；
- 判断在 `nextTick` 后做（那时菜单已渲染、量得到真实尺寸）。

**测试**：`action-menu-anchor.test.ts`（3 条：空间充足贴指针 / 下方不足上翻 / 右侧不足左移）。
jsdom 无布局引擎，故 stub `HTMLElement.prototype.getBoundingClientRect` 与窗口尺寸；
**桩必须在挂载前打**——组件渲染后先量一次再判断，挂载后再 stub 就晚了一步（第一版测试就是这么写错的，已记在此）。

### 2.5.5g 深色主题下行号栏不匹配（用户实测）

**现象**：深色主题下编辑器正文是深色，**行号栏却是浅色**（`#f5f5f5` 那一类）。

**根因（源码为证）**：CM6 的默认样式用 **`&light` / `&dark` 修饰符**：

```js
"&light .cm-gutters": { backgroundColor: "#f5f5f5", color: "#6c6c6c", border: "0px solid #ddd" },
"&dark  .cm-gutters": { backgroundColor: "#333338", color: "#ccc" },
"&light .cm-activeLine": { backgroundColor: "#cceeff44" },
```

而这两个修饰符由 CM6 **自己的 theme facet** 决定（`EditorView.darkTheme`），
我们从未设置过 → 它一直按 **light** 走。所以不是"我们写错了颜色"，而是**没告诉 CM6 主题**。

**修法两层**：

1. **显式告知明暗**：编辑器挂 `EditorView.darkTheme.of(isDark)`（跟随 `useTheme().resolvedTheme`，
   用 Compartment 在切换时重配）——这样它自带的 `&dark` 规则、以及其它 CM6 扩展（如查找）
   都会跟着换；
2. **用我们的 token 覆写关键面**：`.cm-gutters`（底色 `--bg-panel`、文字 `--text-dim`、右侧 1px `--border`）、
   `.cm-lineNumbers .cm-gutterElement` 内边距/最小宽、`.cm-activeLine`（accent 8% 极淡底）、
   `.cm-activeLineGutter`（透明 + `--text` 行号）——保证与工作区配色**同源**而不是"接近"。

**测试**：`kb-editor-render` 增 1 条——断言 `view.state.facet(EditorView.darkTheme)` **已被显式设置**
（不再是默认的 undefined），且行号栏 DOM 存在。

### 2.5.6 T7 收尾：外部改动冲突 UI + Git 文件历史（含 pathspec）

**A. 外部改动冲突 UI。** 此前保存遇到"文件已被外部修改"只在预览区丢一行错误文本；
现在弹**冲突条**（`--warning-soft` 底 + 图标 + 说明），两个明确出口：

- **重新载入** → 丢弃本地编辑，丢缓冲、重读磁盘；
- **仍然覆盖** → 以编辑器内容为准（`expectedMtimeMs: null`，即显式跳过 mtime 校验）。

后端不用改：`kb_write_text` 的 `expected_mtime_ms: Option<i64>` 本来就"给值就校验、给 None 就跳过"。

**B. Git 文件历史（"加 pathspec"的意思）。** 现有 `git::history(repo, limit)` 列的是**整个仓库**的提交；
要看"只碰过这个文件的提交"，需要 **pathspec（路径过滤）**——等价于命令行的 `git log -- <path>`。
libgit2 没有这个直通 API，所以新命令 `git::file_history` 自己拼：

1. `Revwalk`（拓扑 + 时间序，HEAD 与远端 tip 都推入，与 `history` 同口径）；
2. 每个提交与其**第一个父提交**做 `diff_tree_to_tree`，diff 带 `DiffOptions::pathspec(file_rel)`；
3. delta 数 > 0 才保留该提交；
4. 用 `limit` 兜住**扫描量**（默认扫 200 个提交），触达上限时 `has_more = true` 如实告知。

另有 `git_file_history(root, rel, limit)` 命令：**知识库根可能只是仓库的子目录**，
所以先 `discover` 仓库、把"根 + 相对根路径"换算成"仓库 + 仓库内相对路径"再查。

**入口**：页签右键与树右键都有「查看文件历史」（文件才有）→ 打开 `KnowledgeFileHistoryDrawer`
（复用 `SideDrawer` 原语）：短 hash + 提交标题 + 作者 + 相对时间；非 git 仓库/未提交/提交很多（截断）三种情况都如实提示。

**测试**：Rust `file_history_tests` 2 条——在临时仓库里造 4 个提交（a.txt 两次、b.txt 两次），
断言 `a.txt` 的历史**只含碰过 a 的两个提交**（这是 pathspec 过滤生效的直接证据）、不存在的路径返回空历史、扫描上限不误报截断。

### 2.5.7 尚未实现（待排期）

### 2.5.8 未做（按优先级留待后续）

- 大纲（侧栏 + 光标跟随）、源代码模式切换、字数统计上状态栏 —— 待用户拍板大纲位置。
- **键盘打开右键菜单**：实现了 `Shift+F10`（Windows/Linux 惯例），但 **macOS 默认把 F10 当媒体键**
  （需系统设置里开"将 F1、F2 等键用作标准功能键"），因此 mac 上主要靠 **Control+点击** 触发。

## 3. 待验（真机）

本轮多次尝试：`screencapture` 返回 `could not create image from display`（屏幕不可用/已锁），无法做 GUI 取证。

| # | 项 | 怎么验 |
|---|---|---|
| ③ | 断网可用 | 断网后重开应用（静态证据已 PASS，需真机确认无网络依赖） |
| ⑤ | 长文性能 | `/tmp/kb-spike/long.md`（260 行中文）的输入延迟与滚动 |
| ⑥ | 主题观感 | 明/暗两套主题下标题、行内代码、引用、公式、表格的观感 |

**spike 样本**（在 `/tmp/kb-spike`，不污染仓库，可直接当知识库根）：
`README.md`（中文 + 行内/块级公式 + mermaid + 列表引用）、`crlf.md`（CRLF）、`gbk.md`（GBK 中文）、`long.md`（260 行中文）。

## 3. 本轮落地的代码

| 文件 | 说明 |
|---|---|
| `src/knowledge/editor/ime-guard.ts` | IME 组字冻结守卫（逐文件对照移植自 SoloMD，MIT，文件头保留署名） |
| `src/knowledge/editor/live-preview.ts` | 标记显隐 + 富文本样式（同上，样式改走本仓库 token） |
| `src/knowledge/editor/math-diagram.ts` | KaTeX 行内/块级 + Mermaid 围栏的块级替换（同上） |
| `src/knowledge/editor/MarkdownEditor.vue` | CM6 宿主：缓冲即源文本、中文优先字体栈、只读开关 |
| `src/knowledge/KnowledgePreview.vue` | `.md` 改用编辑器（按需加载）+ **⌘S 保存**（复用 `kb_write_text`：保编码回写 + mtime 冲突检测）+ 未保存标记 |
| `tests/kb-editor-roundtrip.test.ts` / `tests/kb-editor-decorations.test.ts` | 12 条新单测 |

依赖新增：`@codemirror/{state,view,language,commands,lang-markdown}`、`@lezer/highlight`、`katex@0.18`、`mermaid@12`（均为 MIT）。

> 注：⌘S 保存本属 T7，但 T0 的中文输入测试必然产生编辑——没有保存就等于测试即丢数据，故提前接入（Rust 侧 `kb_write_text` 早已完成并有字节级单测）。

## 4. 门禁

`pnpm gate` 全绿：**Vitest 61 通过**（15 个文件）、ESLint、vue-tsc + vite build、Clippy、**cargo test 66 通过**。
