# 任务报告：i18n 国际化（中/英）

- 日期：2026-09-11
- 分支：`feat/pr-module`（本地开发分支，不推送远端）
- 交付提交：本报告同批

## 1. 任务目标

工作台此前为**中文硬编码**（少量英文如 Open/Closed/All 混排），无语言切换能力。
本次引入国际化：抽出全部用户可见文案，提供中/英两套文案与切换入口，选择持久化。

## 2. 方案选择：零依赖轻量实现

先尝试安装 `vue-i18n`，但 `pnpm add` 被沙箱策略拒绝——安装需写入工作区之外的全局
store（`~/Library/pnpm/store`），报 `unable to open database file`；改用项目内 store
则要求把现有 node_modules 从全局 store 整体重链（需重新拉取全部依赖），风险与收益
不匹配。

因此按实际规模自建：**37 条消息、2 种语言、只需 `{placeholder}` 插值**，用不到
复数/日期/数字格式化——正是 vue-i18n 的主要价值所在。自建约 60 行、零依赖，且组件
统一通过 `useI18n()` 取用，日后换 vue-i18n 只需替换该模块。

## 3. 实现

### 3.1 目录与文件

- `src/i18n/zh-CN.ts`：中文目录，**同时是 key 的唯一事实源**（`MessageKey` 由它推导）。
- `src/i18n/en-US.ts`：英文目录，类型标注为 `Record<MessageKey, string>`——**漏译或
  拼错 key 直接编译报错**，由 `pnpm build` 门禁兜住。
- `src/i18n/index.ts`：`locale` ref、`t()`、`setLocale()`/`toggleLocale()`、`useI18n()`。
- `src/panels/review-label.ts`：`reviewDecision` 枚举 → 文案，供 PR 列表/详情共用
  （此前两处各有一份重复的 `decisionLabel` 映射，顺带合并）。

### 3.2 响应式要点

`t()` 每次调用都读 `locale.value`，因此**在模板中调用**即可随语言切换重渲染。
反之，在 setup 或模块顶层预先算出字符串会"冻结"当时语言——这是本次最需要规避的坑：

- `panel-types.ts` 的 `title` 与 `registry.ts` 的 mode `label` 原本是**文案字面量**，
  二者都是纯数据模块（引入即求值）。改为存 **i18n key**（`titleKey` / `labelKey`），
  由 `PanelShell.vue` / `ModeTabs.vue` 在渲染时 `t()` 解析。
- PR 的 review 标签同理，改为渲染期调用的 `reviewLabel()`。

### 3.3 语言选择

- 持久化键 `hivetask.locale`（与既有 `hivetask.workspace` 等风格一致）。
- 首次启动跟随系统语言（`navigator.language` 以 `zh` 开头 → `zh-CN`，否则 `en-US`），
  读取/写入 localStorage 均带 try/catch（与项目既有防御风格一致）。
- 顶栏右上新增切换按钮（显示目标语言：中文界面显示 `EN`，英文界面显示 `中文`），
  补 `.header-actions` 布局样式。

### 3.4 顺带清理

- `PanelDefinition.title` 是**死字段**（PanelShell 的选项实际直接读 `panelTypes`，
  从不读它），删除该字段与随之失去用途的 `panelTitle()` 辅助函数。
- `stores/pulls.ts` 的中文 `console.error` 改为英文（开发者日志，非 UI）。

## 4. 文件变更

新增（4 个）：`src/i18n/zh-CN.ts`、`src/i18n/en-US.ts`、`src/i18n/index.ts`、
`src/panels/review-label.ts`。

修改（13 个）：`src/App.vue`、`src/components/ModeTabs.vue`、`src/workbench/PanelShell.vue`、
`src/workbench/panel-types.ts`、`src/workbench/registry.ts`、`src/panels/IssueListPanel.vue`、
`src/panels/IssueDetailPanel.vue`、`src/panels/PullListPanel.vue`、
`src/panels/PullDetailPanel.vue`、`src/panels/modes/IssueListMode.vue`、
`src/panels/modes/IssueMilestoneMode.vue`、`src/stores/issues.ts`、`src/stores/pulls.ts`。

## 5. 验证记录

- `pnpm build`（`vue-tsc --noEmit && vite build`）通过，99 模块，无类型错误——
  该门禁同时校验了中英目录的 key 完备性。
- 目录一致性脚本：zh/en 各 37 key，**集合一致**，且逐 key 的 `{}` 占位符完全匹配
  （英文若漏写 `{name}` 会渲染出花括号字面量，类型系统查不出）。
- key 引用检查：37 个 key **全部被源码引用**，无遗漏或死条目。
- 运行期验证（Vite `ssrLoadModule` 加载真实模块，非类型层面）：
  - `zh-CN`：`common.author` → `作者：alice`、`common.comments` → `12 评论`、
    `common.commits` → `3 次提交`；
  - 切到 `en-US`：`Author: alice`、`12 comments`、`3 commits`、
    `mode.milestone` → `Milestones`、`panelTitle.issue.list` → `Issues`；
  - 插值后无残留 `{}` 占位符。
- 残留中文扫描：`src/` 下除 `src/i18n/` 外仅剩语言按钮的「中文」（语言自称，
  本就应保持原文）。

## 6. 已知取舍

- 状态标签（Open/Closed/Merged/All）**保持英文**：这是 GitHub 的既有术语惯例，
  改动会变更用户已熟悉的界面语义，故未纳入本次翻译——如需中文化可后续单独处理。
- `registry.ts` 的 `Unregistered panel type` 为开发者不变式错误，不属 UI 文案。
- 未做复数/日期本地化（当前无相应文案需求）；如后续需要，替换 `src/i18n/index.ts`
  为 vue-i18n 即可，组件侧无需改动。

## 7. 分支与远端状态

- 提交仅存在于本地 `feat/pr-module`，未设置 upstream，未 push。
