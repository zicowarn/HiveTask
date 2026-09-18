# AGENTS.md — Agent/开发者工程约定

> 本文件是任何 AI Agent 或开发者在本仓库工作时的**强制约定**。改动 UI 前先读
> 「平台对齐铁律」与「字号与图标规范」；提交前必跑「质量门禁」。违反约定的改动
> 会被要求返工。

## 平台对齐铁律（涉及「与 GitHub 对齐」的任务必读，违反即返工）

> 背景：本仓库的看板 / 视图面板以 GitHub Projects 为参照实现。历史上多次出现
> 「功能等价但形态不对」的返工——自行发明入口、把图标换成文字符号、用未取证的
> 印象实现交互。以下规则用来杜绝这类跑偏，**没有例外**。

### 三段式（对齐任务的总流程）

**① 分析（取证）→ ② 实现（照抄）→ ③ 适配（桌面发挥）**，逐段走完，不混淆：

| 阶段 | 做什么 | 产出 | 红线 |
|---|---|---|---|
| ① 分析 | GitHub 的视觉形态、DOM 结构、点击行为、连带效果——用开发者工具 / 截图 / 点击复现全部拿到；**组件内每个可见元素都要确认可交互性**（如：omnibar 左侧的 ＋ 图标是建议菜单的开关，曾被当作装饰漏掉）；同一组件有多个入口时，逐一取证每个入口打开后的初始状态 | 形态 + 交互清单（对照表），交用户确认 | 不写代码 |
| ② 实现 | 把①的清单**逐项照抄**进本地：位置、内容、样式、图标、交互一致 | 与平台形态对齐的功能 | 不跳项、不替换、不自创；此阶段不存在发挥 |
| ③ 适配 | 桌面应用 ≠ web：在**内容完整、样式统一（token/组件体系）、功能一致**三个前提下，结合本项目情况收口（桌面窗口习惯、复用既有组件、与工作区面板体系整合） | 桌面化最终形态 | 发挥不得削减内容与功能；每处发挥必须在交付说明标注「平台形态 X → 桌面适配 Y + 理由」，不得静默 |

三宗教训对应三段：该分析时动手（未取证就实现）、该照抄时发挥
（自创入口、砍平台有的行）、混淆②③边界（把该照抄的当发挥做且不标注）。

### R1 动手前必须取证（SPEC FIRST）

任何"对齐平台"的 UI/交互改动，**先取证，再写代码**。取证必须来自平台页面本身
（本机浏览器已登录，可直接抓），至少覆盖：

1. **结构**：该处的 DOM/ARIA——标签文案、元素顺序、分组、aria/title；
2. **样式**：字号、颜色、内边距、圆角、宽度、悬停态（页面实测值，不是"看起来差不多"）；
3. **图标**：Octicon `<path>` 原样抓取（禁止凭印象手绘、禁止用 `＋`/`⋯`/`√` 文字符号顶替图标）；
4. **点击后的形态**：弹层/输入条/对话框的完整内容与按钮；
5. **行为**：提交、Esc、外点关闭、聚焦环等。

取证结果（截图路径 + 关键 DOM 片段/色值）必须写进该次交付说明，作为验收依据。
**未取证不得开工**；取证不完整时，先补齐再写实现。

### R2 照抄优先，禁止自创（②实现阶段）

- 阶段②只做照抄：平台**有**的元素，位置、文案、图标、顺序、交互逐项一致；
- 平台**没有**的元素：阶段②**不得新增**。若认为平台缺某能力，必须停下来交
  证据（列出已查过的位置与结论）+ 请对方指认，**不得自行设计替代入口**；
- 文案照抄（含占位符文本、aria/title）；图标一律用平台原路径（Octicon 抓取）；
- 与本项目的差异（桌面习惯、既有组件复用）**只能在阶段③做，且必须标注**
  「平台形态 X → 桌面适配 Y + 理由」——静默的发挥视同自创，返工。

### R3 每项必须"形态验证"，类型检查不算验证

完成一项后，必须：

1. 起应用（`pnpm tauri dev`；已有实例可复用）——**用完把 1420 端口还回去**；
2. `screencapture -x` 截图，与平台同位置截图**逐项比对**：位置 / 文案 / 图标 /
   顺序 / 尺寸；
3. 把"截图路径 + 比对结论（逐项：一致 / 差异）"写进交付说明。

`pnpm gate` 全绿只代表编译与逻辑正确，**不代表形态正确**；不得以"门禁绿"宣称
对齐完成。

### R4 删除类指令按"对象层级"确认，不得偷换

指令说"删除 / 去掉 X"时，先确认 X 是**控件本体 / 其中一个条目 / 只是文案**哪一层。
禁止用"改文案、改默认值、保留控件"的方式敷衍删除要求；拿不准时用一句话确认层级
（例："删的是控件本体，不是它的文案，对吗？"），然后按确认结果执行。

### R5 任务交接后不得用"报告"替代"执行"

对方下达"继续 / 直至完成"这类交接后，除**只有对方能决定的分叉**（必须附证据与
最小候选）外，不得停下来征询或只给计划；每轮结束前，当前项必须已做到
**实现 + 形态验证 + 门禁绿** 三件套。

### R6 一次往返原则

需要澄清时，一个问题只问一次：附平台证据 + 我的候选做法，让对方一次点选；不得
把本可自行取证的问题丢给对方。

### R7 对齐清单留痕

每个"对齐平台"的任务，交付说明里给出逐项对照表（平台形态 → 我们的实现 → 证据
截图），便于逐项验收与复查。

## 字号与图标规范（强制引用遵守）

**规则：任何 `font-size` 声明禁止使用裸像素值（`font-size: Npx`），必须引用
以下五档 token。需要新档位时，先在 `styles.css :root` 扩 token 再使用——
不得私自引入体系外尺寸。**

Token 定义处：`src/styles.css` `:root`（单点修改全局生效）。

| Token | 尺寸 | 语义 | 典型用途 |
|---|---|---|---|
| `var(--font-xs)` | 10px | 徽标/角标 | chip、pill、计数角标 |
| `var(--font-sm)` | 11px | 次级元信息 | 日期、作者、meta 行、组头元数据 |
| `var(--font-md)` | 12px | **默认 UI 文本** | 按钮、输入框、下拉、面板标题、组头次级 |
| `var(--font-base)` | 13px | **内容主文本** | Issue/PR 标题行、组头名称、列表主文本 |
| `var(--font-xl)` | 17px | 大标题 | 详情页标题、About、对话框主标题 |

配套规则：

1. **图标统一 `--icon-size: 14px`**：所有 SVG 图标（EditorIcon 及各内联
   SVG）尺寸必须挂 `var(--icon-size, 14px)`，禁止写死 11/12/13px 等杂值。
   图标一律走 `EditorIcon.vue`，两族并列：
   - **Octicon 族（`o.*`）**：viewBox 16、`fill=currentColor`，**路径必须从平台
     页面抓取**（Edit option / Actions 菜单 / Add item 等处用到的那套）——涉及
     对齐的图标一律用这一族；
   - 自绘族（14 viewBox、stroke=currentColor）：仅用于平台没有对应物的图标。
2. **语义对齐**：内容主文本（Issue/PR 标题）= `--font-base` + 600 字重；
   次级元信息 = `--font-sm` + `--text-dim`——同类元素必须同档，不得
   「看着调」。
3. **层级示例**（列表面板）：组头名称 `font-base`/600 > 组头元数据
   `font-sm`/dim ≈ Issue meta 行 `font-sm` > 计数角标 `font-xs`。

## 菜单与弹层规范（强制引用遵守）

**规则：下拉选择一律使用 `src/components/DropdownMenu.vue`；命令型菜单
（`⋯` 这类 Actions 菜单）一律使用 `src/components/ActionMenu.vue`。禁止原生
`<select>`（其系统弹层带渐变、语言不随应用 i18n）与自绘一次性菜单变体
（`*-menu` / `*-toggle` 类实现）。**

- 选择型（DropdownMenu）：触发器 = 语言选择器同款 22px 描边小盒 + 右侧
  chevron；菜单面板 = 扁平 ✓ 勾选行（`--bg-panel` 纯色底 + 浅投影 +
  `--bg-hover` 悬停），**无任何渐变**；单选即选即关；`multiple` 保持展开连续
  勾选；外部点击 / Esc 关闭由组件统一处理，调用方不得重复实现；
- 命令型（ActionMenu）：分组标题 + 危险项红字 + 可选行首图标，形态对齐平台的
  Actions 菜单（列 / 组 / 条目 / 位置 四段式）；菜单项为 `div role="menuitem"`
  （**禁止在 `<button>` 内嵌 `<button>`**）；
- 弹层若含绝对定位菜单，**其祖先不得设 `overflow`**（会裁掉菜单——曾因此出现
  "菜单点开是空的"假象）；
- **外壳右键不得弹 WebView 默认菜单**：没接管右键的区域会被 WKWebView 塞上
  "Reload / Inspect Element"（dev 构建）或 macOS 的 Look Up / Translate / Services，
  网页味很重。统一由 `src/context-menu.ts` 在全局拦（可编辑控件 / 链接 / 有选中文本
  时放行，`⌥` 或 `⌘` + 右键是调试逃生口）。**新加的右键菜单必须在自己的元素上
  `preventDefault`**（`.prevent`），不要依赖全局拦截；
- 例外：日期（`input[type=date]`）与取色器（`input[type=color]`）为系统
  原生控件，不在本规范内。

## 运行时约束：依赖必须跑在**应用自带的 WKWebView** 上（强制）

**规则：引入任何前端依赖前，先确认它在 macOS WKWebView 上能加载。**
应用不是浏览器：WKWebView 的 JS 特性集合与同机 Safari **不一致**——
Safari 有的新全局，WKWebView 可能没有。

已经踩过的坑（原文照录，别再重演）：

- **pdfjs-dist 6 / 4 的常规构建直接引用 `Iterator.prototype` 与 `Promise.withResolvers`**，
  在 WKWebView 里一加载就 `ReferenceError: Can't find variable: Iterator`（用户实测）；
  即便本机 Safari 是 18.6，WKWebView 里 `Iterator` 仍然缺失。
  修法：用官方为较老引擎准备的 **legacy 构建** `pdfjs-dist/legacy/build/pdf.mjs`
  （自带 core-js polyfill，会自己装上 `Iterator`）。**升级 pdfjs 时不要换回常规构建。**

引入新依赖时的做法：

1. 挑 3–5 年内的稳定大版本，别直接上刚发布的大版本；
2. 用下面这条命令扫一遍（`Iterator` / `Promise.withResolvers` / `Array.fromAsync` /
   `Object.groupBy` / `Float16Array` / `RegExp.escape` 等在 WKWebView 里都不保险）：
   ```bash
   pnpm exec node -e '
     const {execSync}=require("child_process");
     console.log(execSync(`grep -rlE "Iterator\\.(from|prototype)|Promise\\.withResolvers|Array\\.fromAsync|Object\\.groupBy|Float16Array" node_modules/<包名>/dist node_modules/<包名>/lib node_modules/<包名>/build 2>/dev/null`,{encoding:"utf8"}))'
   ```
   （命中不等于一定有问题——例如 `three` 的 `Float16Array` 被 `typeof` 守卫包着——但**必须逐个看过上下文**再放行。）
3. 有 legacy 构建的库优先用 legacy；
4. 交付说明里写清"该依赖在 WKWebView 上的兼容性结论"。

## 数据落盘布局（强制认知，持久化相关任务必读）

> 完整设计见 `docs/design-storage-layout.md`。改动任何持久化行为前先读。

| 数据 | 位置 |
|---|---|
| 登记层（connections / repos 指针 / projects / prefs） | `<app data>/app.db`（全局唯一，appdb.rs） |
| 每仓库索引缓存（issues/pulls/comments 物化视图） | `<app data>/repo-index/<目录名>-<路径指纹>/hivetask.db`（storage.rs） |
| 本地 Issue 事件日志（**真源**） | 仓库 `.git` 内隐藏引用 `refs/hivetask/issues`（journal.rs，事件 commit 链） |
| 仅远端登记的合成仓库目录 | `<app data>/repos-cache/<owner>/<repo>/`（appdb.rs） |

**红线：应用不向用户仓库工作区写入任何文件，不碰 `.git/info/exclude`。**
历史教训：索引曾写进 `<repo>/.hivetask/hivetask.db` 并靠 exclude 打补丁
（2026-09 已迁出，首次 open 自动迁移并清理）。新功能要持久化时：索引/缓存
进 `<app data>`；跟仓库走的数据进 git 对象/引用（只动 tree/blob/ref）；
SQLite 索引是可重建的物化视图，永远不需要同步。

## 质量门禁（提交前必跑）

```bash
pnpm gate   # i18n 键校验 / ESLint / Vitest / vue-tsc+build / Clippy / cargo test
```

- 门禁不绿不提交；ESLint 对裸字号的告警视同错误处理。
- **对齐类任务另需形态验证**（见 R3）：截图对照，缺对照不得宣称完成。
- 实机（UI/交互）验证配方见 `scripts/smoke.md`。
