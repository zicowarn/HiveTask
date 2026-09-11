# 任务报告：工作台 Editor/Mode 架构落地（阶段 A+B）

- 日期：2026-09-10
- 分支：`feat/pr-module`（本地开发分支，不推送远端）
- 基线提交：`23d35aa`（PR 模块 + 工作区面板注册表/PanelShell）
- 交付提交：`d9c48b0`（功能）、`c370168`（头部顺序修复）、`c2757f5`（嵌套分隔条修复）
- 验证仓库：`tauri-apps/tauri`（本地克隆 `/tmp/hivetask-demo`）

## 1. 任务目标

旧版桌面客户端采用 Blender 式三层结构：**Workspace（顶部页签）→ Editor（面板外壳，带头部分屏/关闭控件）→ Mode（面板内可切换视图，切换即重建）**。新版工作台此前只实现了固定的「左列表 + 右详情」双栏，Editor/Mode 两层缺失。

本次按确认的范围实施：

- **阶段 A（Mode 基础设施）**：面板注册表支持 Mode 元数据；Issue 列表面板提供「列表 / 里程碑」两个 Mode，对齐旧版唯一真实存在的双模式面板。
- **阶段 B（Editor 动态布局）**：面板可横向/纵向拆分、关闭，布局树按工作区独立并持久化，重启恢复。

明确不在本次范围：面板类型切换下拉、Issue 创建/编辑、评论等写操作（旧版亦未实现，数据层仅支持只读 `gh issue/pr list/view`）。

## 2. 架构与实现

### 2.1 Mode 层

- `src/workbench/registry.ts`：`PanelDefinition` 增加可选 `modes: ModeDefinition[]`（key / 中文标签 / 组件），`issue.list` 注册「列表」「里程碑」两个 Mode；其余面板保持单 Mode。
- `IssueListPanel.vue` 退为 Mode 宿主：头部放 ModeTabs + 状态筛选 + 刷新，正文用 `<component :is>` 渲染当前 Mode；状态筛选（open/closed/all）与选中项仍是 Pinia store 级状态，Mode 切换与面板复制均共享。
- 新增组件：
  - `components/ModeTabs.vue`：纯受控分段控件（`v-model`）。
  - `panels/IssueRow.vue`：列表行（标题、编号/作者/日期、标签 chips、选中高亮），供两个 Mode 复用。
  - `panels/modes/IssueListMode.vue`：平铺列表 + 空态。
  - `panels/modes/IssueMilestoneMode.vue`：按里程碑分组，节标题吸顶并带计数；命名里程碑按名称排序，「未设置里程碑」固定沉底。
- Mode 选择按面板类型持久化（localStorage 键 `hivetask.panel-mode.issue.list`）。

### 2.2 Editor 层

- `src/stores/workbench.ts`（新增 Pinia store）：
  - 二叉布局树：`LeafNode {id,type:"leaf",panel}` / `SplitNode {id,type:"split",dir:"h"|"v",ratio,first,second}`。
  - 操作：`splitLeaf(id, dir)`（叶子原位替换为 0.5 分割节点）、`closeLeaf(id)`（仅允许有父节点的叶子，兄弟节点继承其位置或成为新根）、`canCloseLeaf`（最后一个面板时关闭按钮禁用）、`resetWorkspace`。
  - 每个 Workspace 一棵独立布局树；深 watch + 250ms 合并写入 localStorage（`hivetask.workbench-layout-v1`）。
  - 读取时递归校验节点结构与面板类型白名单，损坏/缺失按工作区回退默认布局（h 分割 0.38：列表 + 详情）。
- `src/workbench/WorkbenchNode.vue`（新增）：递归渲染器，叶子渲染注册面板并透传 `leafId`，分割节点渲染 SplitPane 并双向绑定 `ratio`。
- `src/workbench/PanelShell.vue`：头部新增 ▥（左右分屏）/ ▤（上下分屏）/ ✕（关闭）三个控件，固定位于面板最右端（筛选/刷新之后）。
- `src/workbench/SplitPane.vue`：`ratio` 改为可选受控 prop（未传时回退内部 ref），拖拽经 Pointer Capture 实现，最小占比 0.18。
- `src/workbench/workspaces.ts`（新增）：工作区纯数据定义（key/label/listPanel/detailPanel），解除 `registry → 面板组件 → PanelShell → workbench store → registry` 的循环导入（曾导致 TDZ 白屏）。
- `src/App.vue`：移除固定双栏，改为 `<WorkbenchNode :key="wsKey" :node="activeLayout" />`。

## 3. 文件变更

新增（7 个）：

- `src/workbench/workspaces.ts`
- `src/workbench/WorkbenchNode.vue`
- `src/stores/workbench.ts`
- `src/components/ModeTabs.vue`
- `src/panels/IssueRow.vue`
- `src/panels/modes/IssueListMode.vue`
- `src/panels/modes/IssueMilestoneMode.vue`

修改（8 个）：`src/App.vue`、`src/workbench/registry.ts`、`src/workbench/PanelShell.vue`、`src/workbench/SplitPane.vue`、`src/panels/IssueListPanel.vue`、`src/panels/PullListPanel.vue`、`src/panels/IssueDetailPanel.vue`、`src/panels/PullDetailPanel.vue`。

功能提交统计：15 文件，+716 / −133。

## 4. 过程中修复的缺陷

1. **头部控件顺序错误**（`c370168`）：初版布局按钮渲染在面板操作槽之前，挤在筛选/刷新左边。调整插槽顺序后为 `标题 ｜ ModeTabs ｜ 状态筛选 ｜ 刷新 ｜ ▥ ▤ ✕`，布局按钮固定最右。
2. **混合嵌套时纵向分隔条塌缩为 5×5**（`c2757f5`）：经「先左右分屏、再上下分屏」复现。根因是 SplitPane 用后代选择器 `.split-pane.horizontal .divider { width:5px }`，嵌套场景下外层横向规则泄漏给内层纵向分隔条，使其 width/height 均为 5px，既不可见也无法抓取。改为子代选择器 `>`，分隔条尺寸只由直接父容器方向决定。纯横向或纯纵向分屏不触发，故首轮测试未发现。
3. **循环依赖白屏**：详见 2.2，抽取纯数据模块解决。
4. 窄面板头部「刷新」竖排换行：两处 `.refresh-btn` 增加 `white-space: nowrap`。

## 5. 验证记录

### 5.1 构建门禁

- `pnpm build`（`vue-tsc --noEmit && vite build`）全程通过，最终 94 模块，无类型错误。

### 5.2 真机验证（Tauri 窗口，tauri-apps/tauri 实时只读数据）

- 里程碑 Mode：默认 50 条 open issue 均无里程碑，正确渲染吸顶分组「未设置里程碑 · 50」；分组算法另用 Node 脚本以构造数据验证（命名组分序、未设置沉底）。
- 横向分屏（▥）：左栏复制出第二个列表面板，两者共享 Pinia 状态；在复制面板点击 #15987，右侧详情联动为该 issue。
- 纵向分屏（▤）：上下堆叠的复制面板状态完全同步。
- 关闭（✕）：关闭中间面板后兄弟面板继承空间；仅剩一个面板时 ✕ 禁用。
- 工作区隔离：切到 Pull Requests 为独立默认布局（PR 列表 + 空详情），切回 Issues 自定义布局不变。
- 重启持久化：杀进程后重新启动，上下堆叠布局树、里程碑 Mode 选择均完整恢复（localStorage 布局树经 sqlite 解码核对，结构与操作结果一致）。
- 分隔条修复后：DOM 实测嵌套纵向分隔条由 5×5 变为 638×5、`row-resize`；真实鼠标下拖 120px，分隔条同步下移 122px，比例实时联动。

### 5.3 数据说明

tauri-apps/tauri 最近 50 条 open issue 无一带里程碑；扩大到最近 300 条仅 2 条有里程碑（2.12、3.0），因此命名里程碑分组的渲染以脚本验证为主，线上数据窗口暂无法直观演示，属数据分布问题，非功能缺陷。

## 6. 已知限制与后续建议

- 拖拽比例持久化已支持，但分割节点初始比例固定 0.5；可考虑记住来源面板的占比偏好。
- 复制面板共享同一 store，筛选状态（open/closed/all）在同类型面板间联动——与旧版行为一致；若未来需要面板独立筛选，需把视图状态下沉到叶子节点。
- 布局持久化未做版本迁移机制（当前键后缀 v1）；后续结构变更需加迁移或版本回退。
- 写操作（创建/编辑 Issue、评论）与面板类型切换下拉按范围约定留待后续阶段。

## 7. 分支与远端状态

- 全部提交仅存在于本地 `feat/pr-module`，未设置 upstream，未执行 push。
- 核验 `git ls-remote --heads origin`：远端仅 `main`，开发分支无泄漏。
- 验证用 dev 进程已退出，端口 1420 与相关子进程已清理。
