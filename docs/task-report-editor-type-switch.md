# 任务报告：Editor 面板类型切换（阶段 C）

- 日期：2026-09-11
- 分支：`feat/pr-module`（本地开发分支，不推送远端）
- 基线提交：`89766da`（Editor/Mode 阶段 A+B 及任务报告）
- 交付提交：`334bcca`（上一阶段报告键名笔误修正）、`74501a6`（本功能）

## 1. 任务目标

阶段 A+B 补齐了 Workspace → Editor → Mode 三层中的 Mode（面板内视图切换）与
Editor 动态布局（分屏 / 关闭 / 持久化），但 Editor 层最后一块——**把某个面板
（叶子）原地切换成另一种面板类型**——按当时范围约定留待后续：

> 明确不在本次范围：面板类型切换下拉……

本次交付该下拉：每个面板头部最左侧出现一个面板类型选择器（Blender 式 Editor
选择器），可把当前叶子切换为四个已注册面板类型中的任意一个（Issue 列表 /
Issue 详情 / PR 列表 / PR 详情），切换就地生效、随布局树持久化。

仍不在范围：Issue 创建 / 编辑、评论等写操作（数据层只读）。

## 2. 设计与实现

### 2.1 面板类型元数据独立成纯数据模块

- 新增 `src/workbench/panel-types.ts`：导出 `panelTypes`（`{type,title}`
  目录）与 `panelTitle()`，不 import 任何 `.vue` 组件。
- 初版曾让 PanelShell 直接从 `registry.ts` 取可切换类型，但这会重新闭合
  `registry → 面板组件 → PanelShell → registry` 的模块环——正是阶段 A+B 曾
  导致 TDZ 白屏、靠抽取 `workspaces.ts` 破除的那一类环。本次按同一先例把
  类型/标题目录抽到纯数据叶子模块彻底消环：
  - `PanelShell`（切换器选项）与 `stores/workbench.ts`（持久化白名单）都
    只依赖 `panel-types.ts`，不再触及组件图。
  - `registry.ts` 的 `PanelDefinition` 增加 `title`，由 `panelTitle(type)`
    填充；`registerPanel` 不再接收标题参数，标题与类型只有一处定义。

### 2.2 布局操作

- `src/stores/workbench.ts` 新增 `setLeafPanel(leafId, panel)`：遍历所有工作
  区布局树定位叶子，命中后**只改写 `node.panel`**（叶子 id、所在分割结构、
  比例均不变）。非法类型直接忽略。
- 持久化白名单 `allowedPanels` 改由 `panelTypes` 统一推导（原先取两个工作
  区默认面板的并集，两者集合相同但现在与「可切换类型」同源，新增面板只需
  维护一处）。
- 切换经由既有的深 watch + 250ms 合并写入，无需额外持久化代码。

### 2.3 头部与透传

- `PanelShell.vue`：移除 `title` prop；当存在 `leafId` 且传入 `panelType`
  时，头部最左侧渲染原生 `<select>`（当前类型受控、`change` 调
  `setLeafPanel`）。头部顺序变为
  `[面板类型选择器] ｜ ModeTabs ｜ 状态筛选 ｜ 刷新 ｜ ▥ ▤ ✕`。
- `WorkbenchNode.vue`：叶子渲染时除 `leaf-id` 外再透传 `:panel-type="node.panel"`。
- 四个面板（Issue/PR 的 List/Detail）`defineProps` 统一增加
  `panelType?: string` 并传给 PanelShell；两个列表面板原先硬编码的
  `title="Issues"/"Pull Requests"` 删除，标题由类型目录接管。

## 3. 文件变更

新增（1 个）：

- `src/workbench/panel-types.ts`

修改（8 个）：`src/workbench/registry.ts`、`src/workbench/PanelShell.vue`、
`src/workbench/WorkbenchNode.vue`、`src/stores/workbench.ts`、
`src/panels/IssueListPanel.vue`、`src/panels/IssueDetailPanel.vue`、
`src/panels/PullListPanel.vue`、`src/panels/PullDetailPanel.vue`。

功能提交统计（`74501a6`）：9 文件，+106 / −30。

## 4. 行为说明与边界

- 切换**不校验工作区归属**：Issues 工作区里也可切出 PR 面板，PR 面板读
  pulls store（已有数据时正常显示）。这是刻意的极简设计——若要限制「每个
  工作区只能出现其对应面板」，需把工作区归属传入选择器，留待有产品需求时再做。
- 切换后面板内容由对应 store 的当前状态决定（如切到 Issue 详情而无选中项，
  显示既有空态「从左侧选择一个 Issue」）。
- 复制出的同类型面板仍共享同一 store 的筛选 / 选中（沿用阶段 A+B 的既有行为，
  本功能不改变）。

## 5. 验证记录

- `pnpm build`（`vue-tsc --noEmit && vite build`）通过，95 模块，无类型错误。
- `vite` dev server（临时端口 5199）下根页面、`PanelShell.vue`、
  `registry.ts` 均 200 转译成功，无模块解析错误；验证后已停服。
- 静态依赖核对：PanelShell → panel-types / store，store → workspaces /
  panel-types，均不再回流到 registry，新增代码无循环依赖。
- 未做 Tauri 真机点击验证（本环境未连 gh 仓库数据窗口）；下拉的运行时交互
  建议下次在真机过一遍：四类型互切、切换后分屏比例不变、重启后切换结果随
  布局恢复。

## 6. 分支与远端状态

- 提交仅存在于本地 `feat/pr-module`，未设置 upstream，未 push。
