# 知识库图片编辑（绘图面板）— 选型调研与实施方案

> 状态：**调研（未开工）**。2026-09-17 起于用户「把绘图功能内置到知识库编辑器」的诉求。
> 上游文档：`docs/plan-knowledge-workspace.md`（知识库实施计划，v2）。
> 本文只回答两件事：**选哪条路线**、**怎么接进现有链路**。

---

## 1. 结论（先看这一段）

| 问题 | 结论 |
|---|---|
| 用现成项目（jspaint / vue-fabric-editor / PaintZ / MarkerOn）？ | **都不建议**。四者要么不可分发（撤包 / 无许可 / 不是图片编辑器），要么是**整份应用**而非可嵌组件（§3、§4） |
| 主路线 | **自研 Canvas2D 绘图面板**（`src/knowledge/draw/`，零新依赖），复用既有落盘链路（`assets.ts` + `kb_write_bytes`） |
| 备选路线 | **fabric.js（MIT）只做「标注」**——对象模型让箭头/方框可选中可再编辑；代价是放弃像素级画笔与填充，且仍需自绘 UI（§7） |
| 明确不做 | 图层、SVG 矢量编辑、滤镜/调色（前者场景不需要，后两者交给「用默认程序打开」） |
| 需要的后端增量 | 仅一处：`kb_write_bytes` 补 `expected_mtime_ms`（要支持「覆盖原图」时必须，§6.3） |
| 技能类型判定 | **不是"对齐 GitHub"任务**（平台无此能力）→ 不受 AGENTS.md R2「不得自创入口」约束，但入口位置仍须复用既有形态，且交付说明须标注「自有能力（平台无此物）」（§9） |

**一句话**：这件事的难点不在"画布怎么写"，而在**需求是不是真的需要位图绘图**——见 §2。

---

## 2. 先拆需求：三个不同的"画图"，只有一个需要新能力

知识库里的"图"其实是三类工作，混在一起谈会直接选错工具：

| # | 工作 | 典型场景 | 现状 | 需要新增 |
|---|---|---|---|---|
| **A** | **画新图** | 手绘草图、示意图、给孩子画个图 | 无 | 画布 + 画笔/形状/文字 → 存成 `assets/` |
| **B** | **改已有图** | **截图标注**（加箭头、圈重点、打码、裁剪） | 无（只能原样粘贴） | 打开已有 PNG → 在其上绘制 → 另存/覆盖 |
| **C** | **结构化制图** | 流程图、时序图、架构图 | **已有**（Mermaid + KaTeX 内置在编辑器里） | 不需要位图绘图 |

**判断**：
- **B 是最高价值、且不可替代的**——这是本功能真正的理由。所有笔记类应用（Typora / Obsidian / Bear）在这一步都很弱，而"截图 + 红框 + 箭头 + 打码"是中文技术文档最高频的配图方式。
- **A 次之**（有更好，没有也能活）。
- **C 已经解决**，不要为了 C 引进画布编辑器——那是把 Mermaid 做不好的事再做一遍。

⚠️ 因此：**如果只需要 C，本方案应当直接终止**（不写一行代码）。选型时把"要不要 A/B"作为第一道闸门，而不是先挑库。

---

## 3. 候选项目取证（逐个核过，不是印象）

| 项目 | 许可 | 活跃度（2026-09-17 核） | 分发形态 | 能否嵌入 | 结论 |
|---|---|---|---|---|---|
| **jspaint** `1j01/jspaint` | MIT | 7,880★，pushed 2026-07-19，仓库 **36.1 MB** | **无 npm 包**（`registry.npmjs.org/jspaint` → 404） | 只能 **iframe**：需把整份应用托管在与宿主**同源**的服务器上；控制走 `iframe.contentWindow` + `systemHooks`，官方自称 **unstable API** | 排除（§4.1） |
| **vue-fabric-editor** `ikuaitu/vue-fabric-editor` | 仓库 MIT（**开源版仅前端代码**） | 7,968★，pushed 2026-07-21，仓库 **201.5 MB**，65 open issues | **不可分发**：npm 包 `vue-fabric-editor` 记录为 **unpublished**（2026-09-11）；`@kuaitu/core` → 404；npm 搜索只剩第三方 fork `kuaitu-nc`（ISC，2024-08-08，仓库 `NoahCodeGG/vue-fabric-editor`） | README **无核心库导入指引**（只有 `pnpm dev` 跑整份应用）；"二次开发/源码授权"指向**付费版** | 排除（§4.2） |
| **PaintZ** `zmyaro/paintz` | **无许可证**（GitHub API `license: null`） | 61★，pushed **2024-02-06**（停更两年半） | 整份 Web 应用 | 理论上 iframe | 排除（§4.3） |
| **MarkerOn** `ifer47/markeron` | MIT | 1,043★，created 2026-03-17，23 open issues | 桌面应用（Tauri v2 + Vue3 + Rust） | — | 排除（§4.4） |
| fabric.js `fabricjs/fabric.js` | MIT | 31,444★，pushed 2026-09-15 | npm `fabric@7.4.0` | 引擎库（无 UI） | **备选**（§7） |
| Excalidraw `excalidraw/excalidraw` | MIT | 132,151★，pushed 2026-09-16 | npm（**React 组件**） | 需引入 React 运行时 | 不适用（§4.5） |
| tldraw `tldraw/tldraw` | **非 MIT**（GitHub API `spdx_id: NOASSERTION` / `Other`） | 50,398★ | npm | — | 排除（§4.5） |

> 用户清单中"`vue-fabric-editor` 可以直接嵌入你 Tauri+Vue 的知识库软件里，作为内置绘图面板"与"`MarkerOn` 代码结构可以直接拿来改造，做成内置绘图面板"**均不成立**，依据见下节。

---

## 4. 排除理由（逐条给证据，便于复查）

### 4.1 jspaint：能嵌，但嵌进来的是一整台"Windows 画图"
- 它的嵌入方式是 **iframe + 同源托管**（README：本地副本"has to be hosted on the same web server as the containing page"），控制靠 `systemHooks`（`showSaveFileDialog` / `showOpenFileDialog` / `writeBlobToHandle` / `readBlobFromHandle`），作者明示 **"The API will change a lot"**。
- 代价：① 它自带 Win95 皮肤（菜单栏/调色板/对话框全套），与我们的 token 体系（五档字号、Octicon 图标、DropdownMenu/ActionMenu）**无法共存**；② 仓库 36.1 MB 需 vendoring 并长期跟上游；③ 不稳定 API；④ 中文 i18n 与我们的键体系是两套。
- **不是不能用**：如果确实要"原汁原味 Windows 画图"，它是唯一解。但那是"内置一个小画图程序"，不是"给知识库加图片编辑"。列入 §8 的彩蛋选项，不作主路线。

### 4.2 vue-fabric-editor：是"设计编辑器整应用"，且**分发包已撤**
- 它是**跑起来的一整套应用**（`pnpm dev` 起 Vite 应用，README 要求 node 18–20 + pnpm 8.x），定位是"介于 web 图片编辑应用与 fabric.js 之间的封装层"，**尚未**提供可导入的核心库（README 原话是"目标是……"，不是"已提供"）。
- 分发事实：npm 包 `vue-fabric-editor` 记录为 **unpublished**（2026-09-11 撤的，就在本周）；`@kuaitu/core` 不存在；搜索只剩第三方 fork `kuaitu-nc`（ISC，2024 年停更）。
- 即使能拿到源码，它是**Canva 式设计编辑器**（模板、素材、图层、字体管理），与"截图加个箭头"的需求错配；且仓库 201.5 MB。
- ⚠️ 若要引用其代码：开源版"仅前端代码"，"源码授权/二次开发"是**付费版**卖点——引用前必须逐文件核许可，不能默认整仓 MIT。

### 4.3 PaintZ：**无许可证 = 保留全部权利**
- GitHub API 返回 `license: null`。无许可即默认版权归作者所有，**代码一行都不能抄**（无论项目自身是不是 AGPL）。停更两年半（2024-02）。
- 这条也顺带说明：选型时"能搜到的项目"≠"能用的项目"，许可证要一个个查。

### 4.4 MarkerOn：它是**屏幕标注悬浮窗**，不是图片编辑器
- 仓库描述：*"Lightweight (~1.5 MB) open-source **screen annotation** with **click-through mode** and keyboard-first shortcuts. For demos, teaching, meetings & screen recording."*
- 它的架构是**透明置顶窗口 + 全局快捷键 + 鼠标穿透**（在屏幕上直接画，服务录屏/演示），与"在编辑器面板里打开一张 PNG 改它"是相反的形态。它的画布代码没有"打开图片/保存图片"这条链路，改造量不比自研小。
- 结论：技术栈确实同源（Tauri v2 + Vue3），但**可复用的是"透明窗口/快捷键"这类与绘图无关的部分**，不是绘图本身。

### 4.5 Excalidraw / tldraw：白板，不是像素绘图
- 用户清单里已标注"容易混淆"，此处只补许可事实：Excalidraw **MIT**（但官方可嵌入产物是 **React 组件**，为它在 Vue 应用里引入 React 运行时不成比例）；tldraw **不是 MIT**（`NOASSERTION`/`Other`，其自有许可含商业使用限制）→ 对本项目（AGPL-3.0-only，禁止叠加额外限制）**直接排除**。
- 另：结构化图表本来就归 Mermaid（§2-C），不需要白板。

---

## 5. 推荐方案：自研 Canvas2D 面板（零新依赖）

### 5.1 为什么自研是这里的最优解（三条都是本项目自身的约束）

1. **形态必须长在我们的 token 里**：绘图面板的工具栏、颜色选择、下拉（笔宽/格式）都要走既有规范（`--font-*` 五档、`EditorIcon` Octicon、`DropdownMenu` / `ActionMenu`）。任何第三方成品 UI 都做不到——这条直接把"嵌整应用"的路线否决。
2. **MS Paint 语义 = 像素语义，通用图形库帮不上**：画笔、橡皮、油漆桶（flood fill）是 `Canvas2D` 原生能力；fabric/Konva 的对象模型反而要绕（§7）。真正需要写的"引擎"部分很薄。
3. **落盘链路已经现成**：`assets.ts`（写 `assets/`、重名加序号、`kb_write_bytes` 原子写 + 根沙箱）与 `image.ts`（本地相对路径 → `kb_read_bytes` → object URL）都已就位。绘图面板的"打开/保存"是**接两根线**，不是新建一套（§6）。

### 5.2 代价（写清，不事后抱怨）

- 新增自持代码 **约 1,600–2,200 行**（拆解见 §5.3），边界情况（撤销内存、retina、IME、超大图）都要自己接。
- 参照该仓库既有实践，这个量级是**可接受且有先例的**：知识库自身的 CM6 栈就是约 5,500 行的自持实现（`docs/plan-knowledge-workspace.md` §2.2）。
- 对照组：jspaint 路线 **0 行自研**，但换来 36 MB vendoring + 不可控 UI + 不稳定 API——相当于用"长期不可控"换"短期省事"。

### 5.3 代码结构（建议目录）

> **✅ P1 增量已落地（2026-09-19）**：§8 的 P1 清单全部完成——图片 widget 悬浮「编辑」、
> 工具条「画图」新建空白画布（`drawn-*` 文件 + 光标处插引用）、油漆桶（扫描线洪水填充，容差 48）、
> 裁剪（两段式：框选 → 应用/取消）、旋转 ±90°/翻转（撤销栈扩展 `cropFrom` 尺寸字段）。
> 台账详见 TASK.md T14 节。
>
> **⚠️ 形态修订（2026-09-17 用户口径，随 T14-D 轮实施生效）**：宿主形态由「全窗模态 DrawDialog」
> 改为**预览面板内嵌编辑态**——点预览头「编辑图片」→ 头部出现绘图工具条（与 Markdown 编辑器
> 头部功能操作栏同一槽位、同一形态语法），预览体换成画布；保存/取消在头部动作区。
> 理由：① 用户指定「部分操作参考 Markdown 编辑器的头部功能操作栏」；② 与 Markdown 编辑
> 共用「头部工具条 + 内容区」的既有语法，不新增第三套外壳；③ 编辑锁期间 load() 早退，
> 面板内状态生命周期天然清晰。三个入口中 P0 落地**预览头**一处；图片 widget 悬浮编辑与
> 「画图」新建空白画布命令留待下一增量。

```
src/knowledge/draw/
  DrawToolbar.vue     工具条（面板头形态：22px 钮 / 竖线分组 / DropdownMenu / Octicon+自绘图标）
  DrawCanvas.vue      画布（三层：work 真相 / overlay 预览 / visible 合成；指针交互；文字 DOM 浮层）
  session.ts          会话状态单例（工具/颜色/笔宽/字号/undo/redo/dirty）+ 工具表与预设
  geometry.ts         纯几何：坐标换算 / 矩形规整 / 箭头头部 / 脏矩形（Vitest 直测）
  history.ts          撤销栈：脏矩形 patch + 字节预算淘汰（不存全画布快照）
```

- 与原计划的差异：`tools.ts`/`render.ts`/`io.ts` 合并进 `DrawCanvas.vue`（工具状态机与
  渲染原语强耦合于 canvas 上下文，拆文件反而要传一串 context；纯逻辑已抽到 geometry/history）；
  `palette.ts` 并入 `session.ts`；`transform.ts` 即 `geometry.ts`；`io.ts` 的打开/保存走宿主
  （KnowledgePreview 既有 load/save 链路），不另设一层。

---

## 6. 与现有工程的融合点（逐文件，已核对源码）

### 6.1 三个入口（全部复用既有动作区，不新造外壳）

| # | 入口 | 落点 | 现状 |
|---|---|---|---|
| 1 | 图片文件的**预览头**「编辑图片」 | `src/knowledge/KnowledgePreview.vue` → `head-actions`（紧邻既有的「用默认程序打开」） | 该动作区已有 3 个 Markdown 专用按钮 + 主操作；图片分支只显示主操作 → 加一个按钮即可 |
| 2 | 编辑器内**图片 widget** 悬浮「编辑」 | `src/knowledge/editor/image.ts` → `ImageWidget` | 现 `ignoreEvent(): true`（不吞事件给 CM6）；加按钮需按事件目标放行，避免光标定位失效 |
| 3 | 工具条**「画图」命令**（新建空白画布） | `src/components/markdown-tools.ts` → 新增 `draw` 命令（`kind: "insert"`，图标从 `@primer/octicons` 抓 `paintbrush`，**不得自绘**）；只加入 `EDITOR_COMMAND_GROUPS` | `MARKDOWN_COMMANDS` 是工具条/快捷键/右键菜单的**单一事实源**；`ISSUE_TOOLBAR_KEYS` **不动** → Issue/评论编辑器形态零变化 |

### 6.2 保存链路（复用，不新建）

```
canvas.toBlob("image/png")
  → base64
  → api.kbWriteBytes(root, rel, base64)     // 已有：根沙箱 + 自动建父目录 + 临时文件 rename 原子写
  → 插入/替换 Markdown 引用：![alt](assets/xxx-edited-20260917-153000.png)
```

- 命名沿用既有 `pastedFileName()` 同款时间戳方案（`assets.ts:26`），新增 `edited-` / `drawn-` 前缀。
- 引用插入复用 `assetLink()`（`assets.ts:21`）。

### 6.3 唯一需要的后端增量：`kb_write_bytes` 补 mtime 守卫

- 现状：`kb_write_text` 带 `expected_mtime_ms`（`src-tauri/src/kb.rs:424`），**不符即拒绝覆盖**；而 `kb_write_bytes` **没有**该参数（`src-tauri/src/kb.rs:1084`）。
- 影响：只要允许"覆盖原图"（B 场景的自然诉求），就必须有冲突保护——否则外部程序改了这张图，我们一保存就把它冲掉（文本链路当初正是为此加的守卫）。
- 改法：`kb_write_bytes(..., expected_mtime_ms: Option<i64>)`，语义与文本版一致；`Option` 为空 = 不校验（兼容既有的粘贴插图调用）。新增单测：mtime 不符拒绝、为空放行。

### 6.4 i18n / 图标 / 字号（不新增体系外的值）

- 文案挂 `kb.draw.*`（`src/i18n/{zh-CN,en-US}.ts`，`scripts/check-i18n.mjs` 校验两语齐）。
- 工具图标一律 Octicon 族 `o.*`（`paintbrush` / `pencil` / `eraser` / `typography` / `arrow-right` / `square` / `circle` / `search`(取色) / `undo` / `redo` / `screen-full` …），**路径从 `@primer/octicons` 抓取**；缺失的形态用自绘族 `x.*` 并在交付说明标注。
- 字号一律 `var(--font-*)`；图标挂 `var(--icon-size)`。

---

## 7. 备选路线：fabric.js 只做「标注」

**适用条件**：如果评估后认为"主要做 B（标注截图）"、且希望**画上去的箭头/方框保存后还能再选中、移动、改色**——那是对象模型的优势，Canvas2D 的位图语义做不到（画上去就烧进像素了）。

| 维度 | 自研 Canvas2D（主路线） | fabric.js（备选） |
|---|---|---|
| 画笔 / 橡皮 / 油漆桶 | 原生能力，直接写 | 自由绘制可（`PencilBrush`），**油漆桶没有** |
| 标注可再编辑 | ✗（像素一次性） | ✓（对象可选中/移动/改色） |
| 依赖 | 0 | `fabric@7`（MIT；包体需实测，v6 起为 ESM 模块化） |
| UI | 自绘（走我们的 token） | **仍需自绘**（fabric 不含 UI，故不违反设计规范） |
| 适合 | A + B | 仅 B |

**决策规则**：先定"要不要 A（自由手绘）"。要 A → 主路线；只要 B 且要"标注可再编辑" → 备选。**不要混用**（两套画布状态并存是最糟的组合）。

---

## 8. 功能范围（P0/P1/不做）

**P0（MVP，一次交付）**
- 画布来源：① 当前图片文件 ② 文档内引用的图片 ③ 空白新建（尺寸预设 + 自定义）
- 工具：画笔、橡皮、直线、箭头、矩形、椭圆、文字
- 属性：调色板 + 自定义色、笔宽 3–5 档
- 编辑：撤销 / 重做（`⌘Z` / `⇧⌘Z`）、缩放（`⌘+` / `⌘-` / `⌘0` 适应窗口）、空格拖拽平移
- 输出：PNG（默认）/ JPEG / WebP；**另存为新文件**到文档同级 `assets/` 并插入引用（默认不覆盖原图）

**P1**
- 油漆桶、裁剪、旋转/翻转、马赛克（打码，B 场景刚需）
- **覆盖原图**（依赖 §6.3 的 mtime 守卫）
- 从剪贴板直接进入画布（`⌘V` → 画布而非直接落盘）

**不做（写清理由，避免验收时被当缺失）**
- **图层**：知识库配图不需要；成本与撤销模型复杂度都不成比例。
- **SVG 矢量编辑**：结构化图表归 Mermaid（§2-C）。
- **滤镜/调色/批量处理**：属图像处理，交给「用默认程序打开」（既有口径，`docs/plan-knowledge-workspace.md` §1.4）。

**彩蛋选项（非主路线）**：若确实想要"原汁原味 Windows 画图"，用 jspaint vendoring + iframe，`systemHooks` 接管打开/保存走 `kb_*`（技术上可行）。代价见 §4.1——**它是一整个小应用，不是面板**。

---

## 9. 纪律口径（AGENTS.md）：这是"自有能力"，不是"对齐任务"

- 本功能**平台（GitHub）没有**。AGENTS.md R2 的"平台没有的元素不得新增"约束的是**对齐类**任务；绘图属于**桌面自有能力**，因此不受 R2 限制。
- 但两条仍须遵守，否则将来会被误判为跑偏：
  1. **入口不得自创形态**——三处入口全部落在既有动作区（预览头动作区、工具条命令表、图片 widget），不新造第三套弹层/菜单外壳；
  2. **交付说明必须标注**为「自有能力（平台无此物）」+ 每处桌面适配写明「平台形态 X → 桌面适配 Y + 理由」（本方案的适配点是"全窗模态而非 SideDrawer"与"不新增面板类型"，理由见 §5.3）。
- 门禁照常：`pnpm gate` 六步全绿 + **R3 形态验证**（截图对照；绘图是新增能力，无平台同位置截图可比对，改为**与 macOS 预览.app 的标注工具对比交互完备性**，并在交付说明列出比对项）。
- 许可记账：本方案**零新依赖**，主路线不新增 `THIRD-PARTY.md` 条目；若改走 §7 备选，需加 `fabric.js`（MIT，保留版权声明）。

---

## 10. 风险与待实测（不得按印象宣称完成）

1. **撤销内存**：全画布快照 1920×1080 ≈ 8.3 MB/步；必须用**脏矩形 patch** 或严格限步（建议 ≤30 步 + 画布边上限），否则大图上连续画十几笔就吃掉几百 MB。**需实测**。
2. **中文文字工具**：canvas 直接监听键盘会**废掉输入法候选窗**。文字工具必须用 DOM `<input>` 浮层承接输入（仓库已有 IME 经验：`editor/ime-guard.ts`）。**必须实机用拼音连打验证**。
3. **Retina**：`canvas.width = cssW × devicePixelRatio` + `ctx.scale(dpr, dpr)`，否则 macOS 上发虚。**实机截图对比**。
4. **大图传输**：`kb_write_bytes` 走 base64（+33%），10 MB PNG → 13.4 MB 字符串过 IPC；读路径有 **32 MB 上限**（`kb.rs:17` `MAX_READ_BYTES`）。若实测慢，再评估 Tauri v2 原始字节通道（**需实测，不预设**）。
5. **超大图**：>4096px 的图加载时应降采样显示并提示，避免一次吃掉几百 MB。
6. **图片 widget 的按钮事件**：`ImageWidget.ignoreEvent()` 当前返回 `true`；加按钮后若放行不当，会连带破坏 widget 附近的文本光标定位。**需回归验证**（点击 widget 内文本、点击按钮、拖动选区三种情形）。
7. **覆盖原图与引用一致性**：若改名另存，文档里旧引用仍指向旧图（不自动重写）；若覆盖，需 §6.3 的守卫。两种语义要在 UI 上明确（"另存为"vs"覆盖"）。

---

## 11. 参考与许可（`THIRD-PARTY.md` 增量）

| 项目 | 许可 | 借鉴形式 | 具体 |
|---|---|---|---|
| jspaint `1j01/jspaint` | MIT | **评估未采用**（留痕） | 评估其 iframe + `systemHooks` 嵌入路径；未采用原因：整份 Win95 应用、36.1 MB vendoring、不稳定性 API、UI 与 token 体系冲突 |
| vue-fabric-editor `ikuaitu/vue-fabric-editor` | 仓库 MIT（开源版仅前端；二次开发属付费版） | **评估未采用**（留痕） | 依据：npm 包 `vue-fabric-editor` 已 unpublished（2026-09-11）、`@kuaitu/core` 不存在、README 无核心库导入指引、201.5 MB、需求错配 |
| PaintZ `zmyaro/paintz` | **无许可证** | **不可使用**（留痕） | GitHub API `license: null` → 默认保留全部权利，代码不可抄 |
| MarkerOn `ifer47/markeron` | MIT | **评估未采用**（留痕） | 实为屏幕标注悬浮窗（click-through / 录屏演示），非图片编辑器 |
| tldraw `tldraw/tldraw` | 非 MIT（`NOASSERTION`） | **不可使用**（留痕） | 自有许可含商业限制，与本项目 AGPL-3.0-only 不可叠加 |
| Excalidraw `excalidraw/excalidraw` | MIT | **评估未采用** | 可嵌入产物为 React 组件；且属白板类，非像素绘图 |
| fabric.js `fabricjs/fabric.js` | MIT | **仅备选**（§7，未采用则不记账） | 若启用：保留版权与许可原文 |

> 取证口径：许可与活跃度均于 **2026-09-17** 经 GitHub REST API 与 npm registry 实查，数值见 §3 表。

---

## 12. 实施顺序（若开工；台账编号 **T14**，子阶段 D0–D6）

| 阶段 | 内容 | 验收 |
|---|---|---|
| D0 | 决策闸门：确认 A/B 是否都要（§2）；确认主路线 vs §7 备选 | 一句话记录，避免返工 |
| D1 | `kb_write_bytes` 补 `expected_mtime_ms` + 单测 | `cargo test` 绿 |
| D2 | 画布内核：`transform` / `history` / `render` / `tools`（纯逻辑 + 单测） | Vitest 覆盖坐标换算、撤销栈、工具状态迁移 |
| D3 | `DrawDialog` 外壳 + 工具条 + 调色板（走 token 与 Octicon） | 截图对照规范（字号/图标/下拉） |
| D4 | 三个入口接线（预览头 / widget / 工具条命令）+ 保存与引用插入 | 实机：打开→画→保存→引用出现在文档且图片可渲染 |
| D5 | 中文 IME 实机验证 + retina 截图 + 撤销内存实测 | 三项证据写进交付说明 |
| D6 | 形态与纪律留痕：入口对照表 + 「自有能力」标注 + 许可记账核对 | 交付说明含逐项对照 |

---

## 13. 待用户决策（只有一个分叉）

1. **范围**：只要 B（截图标注）？还是 A + B 都要？（→ 直接决定 §7 的分岔）
2. 其余按 §1 结论执行即可，无需逐项确认。
