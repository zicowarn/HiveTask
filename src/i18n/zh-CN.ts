/**
 * zh-CN message catalog — the source of truth for message keys.
 * `MessageKey` is derived from this object, so en-US.ts fails to compile
 * if it misses (or misspells) a key.
 *
 * Interpolation uses `{name}` placeholders, substituted by `t()`.
 */
export const zhCN = {
  // App header
  "app.repoNone": "未选择仓库",
  "app.repoPick": "选择仓库",
  "app.repoSwitch": "切换仓库",
  "app.ghMissing": "未检测到 gh CLI。请先安装并完成登录：",
  "lang.switch": "切换语言",
  "theme.switch": "切换明亮 / 暗色主题",

  // Panel chrome
  "panel.switchType": "切换面板类型",
  "panel.splitH": "左右分屏",
  "panel.splitV": "上下分屏",
  "panel.close": "关闭面板",

  // Panel types (dropdown labels)
  "panelTitle.issue.list": "Issue 列表",
  "panelTitle.issue.detail": "Issue 详情",
  "panelTitle.pull.list": "PR 列表",
  "panelTitle.pull.detail": "PR 详情",

  // Panel modes
  "mode.list": "列表",
  "mode.milestone": "里程碑",

  // Shared strings
  "common.refresh": "刷新",
  "common.syncing": "同步中…",
  "common.empty": "暂无数据，点击「刷新」从 GitHub 拉取",
  "common.noBody": "（无描述内容）",
  "common.openInGithub": "在 GitHub 打开",
  "common.loadingFull": "正在从 GitHub 加载完整信息…",
  "common.draft": "草稿",
  "common.merged": "已合并",
  "common.unassignedMilestone": "未设置里程碑",
  "common.author": "作者：{name}",
  "common.assignees": "负责人：{name}",
  "common.reviewers": "评审：{name}",
  "common.comments": "{n} 评论",
  "common.commits": "{n} 次提交",

  // Issue workspace
  "issue.emptySelect": "从左侧选择一个 Issue 查看详情",
  "issue.emptyRepo": "先选择一个本地 Git 仓库，然后刷新 Issues",

  // Pull request workspace
  "pull.emptySelect": "从左侧选择一个 Pull Request 查看详情",
  "pull.emptyRepo": "先选择一个本地 Git 仓库，然后刷新 Pull Requests",

  // GitHub reviewDecision values
  "review.approved": "已批准",
  "review.reviewRequired": "待评审",
  "review.changesRequested": "需修改",

  // Errors surfaced in the panel banner
  "error.browserPreview": "浏览器预览模式无法调用本地 gh，请在 Tauri 窗口中操作",
} as const;

export type MessageKey = keyof typeof zhCN;
