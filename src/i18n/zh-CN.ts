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
  "lang.system": "跟随系统",
  "theme.switch": "主题：暗色 → 亮色 → 跟随系统（点击循环）",

  // Menus
  "menu.file": "文件",
  "menu.edit": "编辑",
  "menu.view": "视图",
  "menu.tools": "工具",
  "menu.help": "帮助",
  // Workspaces (header tabs)
  "workspace.issues": "Issues",
  "workspace.pulls": "Pull Requests",
  "workspace.tools": "工具",

  "menu.issues": "Issues",
  "menu.pulls": "Pull Requests",
  "menu.undo": "撤销",
  "menu.redo": "重做",
  "menu.cut": "剪切",
  "menu.copy": "拷贝",
  "menu.paste": "粘贴",
  "menu.selectAll": "全选",
  "menu.services": "服务",
  "menu.hide": "隐藏 HiveTask",
  "menu.hideOthers": "隐藏其他",
  "menu.showAll": "全部显示",
  "menu.quit": "退出 HiveTask",
  "menu.openRepo": "选择仓库…",
  "menu.preferences": "偏好设置",
  "menu.toggleStatusbar": "显示状态栏",
  "menu.copyUrl": "复制链接",
  "menu.about": "关于 HiveTask",

  // Status bar
  "statusbar.noRepo": "未选择仓库",
  "statusbar.syncedAt": "{time} 同步",
  "statusbar.ghOk": "gh CLI 可用",
  "statusbar.ghMissing": "未检测到 gh CLI",
  "statusbar.online": "在线",
  "statusbar.offline": "离线",
  "statusbar.onlineTitle": "GitHub 连接正常，点击重新检测",
  "statusbar.offlineTitle": "无法连接 GitHub，正在显示本地缓存；点击重试",

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
  "panelTitle.settings": "设置",
  "panelTitle.git.history": "Git 历史",
  "panelTitle.terminal": "终端",

  // Git history panel
  "gitHistory.fetch": "抓取远端",
  "gitHistory.branches": "分支",
  "gitHistory.moreBranches": "还有 {n} 个分支",
  "gitHistory.collapse": "收起",
  "gitHistory.colGraph": "图",
  "gitHistory.colDate": "日期",
  "gitHistory.colAuthor": "作者",
  "gitHistory.colCommit": "提交",
  "gitHistory.parents": "{n} 个父提交",
  "gitHistory.noCommits": "仓库还没有提交",
  "gitHistory.aheadBehind": "领先 {ahead} · 落后 {behind}",
  "gitHistory.clickToFilter": "点击只看该分支的历史",

  // Terminal panel
  "terminal.exited": "—— shell 已退出 ——",
  "terminal.restart": "重新启动",

  // Editor 切换弹层分类
  "editorCat.issues": "Issues",
  "editorCat.pulls": "Pull Requests",
  "editorCat.tools": "工具",
  "editorCat.general": "通用",

  // Panel modes
  "mode.list": "列表",
  "mode.milestone": "里程碑",
  "mode.settings.basic": "基础设置",

  // Issue/PR state (filter tabs + detail badges)
  "state.open": "开启中",
  "state.closed": "已关闭",
  "state.merged": "已合并",
  "state.all": "全部",

  // Settings — basic mode
  "settings.language": "语言",
  "settings.languageDesc": "界面显示语言",
  "settings.theme": "主题",
  "settings.themeDesc": "界面配色，「跟随系统」时随系统外观自动切换",
  "settings.themeDark": "暗色",
  "settings.themeLight": "明亮",
  "settings.themeSystem": "跟随系统",
  "settings.terminalShell": "终端 Shell",
  "settings.terminalShellDesc": "集成终端使用的 Shell，立即对新开的终端生效",
  "settings.shellAuto": "跟随系统默认",
  "settings.statusbar": "显示状态栏",
  "settings.statusbarDesc": "在窗口底部显示仓库与同步状态",

  // About dialog
  "about.description":
    "独立的项目管理桌面工具——「Have a task」：管理 GitHub 仓库的 Issues、Pull Requests 与里程碑。",
  "about.version": "当前版本",
  "about.builtWith": "基于 Vue 3 + Tauri 2 构建",
  "about.license": "开源许可（MIT）",
  "about.libraries": "第三方组件",
  "about.copyright": "版权所有 © {year} HiveTask Contributors",
  "about.close": "关闭",

  // Shared strings
  "common.refresh": "刷新",
  "common.syncing": "同步中…",
  "common.empty": "暂无数据，点击「刷新」从 GitHub 拉取",
  "common.noBody": "（无描述内容）",
  "common.openInGithub": "在 GitHub 打开",
  "common.loadingFull": "正在从 GitHub 加载完整信息…",
  "common.draft": "草稿",
  "common.unassignedMilestone": "未设置里程碑",
  "common.author": "作者：{name}",
  "common.assignees": "负责人：{name}",
  "common.reviewers": "评审：{name}",
  "common.comments": "{n} 评论",
  "common.commits": "{n} 次提交",

  // Comments (write-through)
  "comments.title": "评论",
  "comments.empty": "暂无评论",
  "comments.placeholder": "写下评论，支持 Markdown（⌘↵ 发送）",
  "comments.send": "评论",
  "comments.sending": "发送中…",

  // Merge (irreversible — dialog confirm)
  "merge.button": "合并",
  "merge.working": "合并中…",
  "merge.title": "合并 Pull Request",
  "merge.hint": "合并后 PR 将关闭，此操作不可撤销。",
  "merge.confirm": "确认合并",
  "merge.cancel": "取消",
  "merge.merge": "创建合并提交",
  "merge.mergeDesc": "保留分支上的全部提交，并附加一个合并提交",
  "merge.squash": "压缩为单个提交",
  "merge.squashDesc": "全部改动压缩为一个提交进入主分支",
  "merge.rebase": "变基合并",
  "merge.rebaseDesc": "逐个变基到主分支，不产生合并提交",

  // Detail state actions
  "detail.close": "关闭",
  "detail.reopen": "重新打开",
  "detail.closeConfirm": "再点一次确认关闭",
  "detail.working": "处理中…",

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

  // gh error translations (raw output kept as toast detail)
  "error.permission": "当前账号没有执行此操作的权限",
  "error.notFound": "目标不存在或编号有误（可能已被删除）",
  "error.auth": "gh 认证失效，请在终端执行 gh auth login",
  "error.rateLimit": "GitHub API 限流，请稍后再试",
  "error.locked": "该会话已锁定，无法评论",
  "error.repo": "未找到 Git 仓库或 remote，请确认已选择正确目录",
  "error.network": "网络错误，无法连接 GitHub",
} as const;

export type MessageKey = keyof typeof zhCN;
