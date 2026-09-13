/**
 * en-US message catalog. Typed as `Record<MessageKey, string>` so a missing
 * or misspelled key is a compile error (the build gate catches it).
 */
import type { MessageKey } from "./zh-CN";

export const enUS: Record<MessageKey, string> = {
  // App header
  "app.repoNone": "No repository",
  "app.repoPick": "Choose repository",
  "app.repoSwitch": "Switch repository",
  "app.ghMissing": "gh CLI not found. Install and sign in first:",
  "repoTab.github": "GitHub",
  "repoTab.gitee": "Gitee",
  "repoTab.gitea": "Gitea",
  "repoTab.local": "Local",
  "repo.addLocal": "Local folder…",
  "repo.addRemote": "Remote URL…",
  "repo.remoteLater": "Register a remote-only repo by URL",
  "repo.remotePlaceholder": "https://gitee.com/owner/repo",
  "repo.remotePlatform": "Platform",
  "repo.remoteOnly": "Remote-only",
  "repo.tabEmpty": "No repositories registered for this source",
  "repo.current": "Current",
  "repo.deleteTitle": "Remove registration (repo data is kept)",
  "lang.switch": "Switch language",
  "lang.system": "System",
  "theme.switch": "Theme: dark → light → system (click to cycle)",

  // Menus
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.tools": "Tools",
  "menu.help": "Help",
  // Workspaces (header tabs)
  "workspace.issues": "Issues",
  "workspace.pulls": "Pull Requests",
  "workspace.tools": "Tools",

  "menu.issues": "Issues",
  "menu.pulls": "Pull Requests",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",
  "menu.services": "Services",
  "menu.hide": "Hide HiveTask",
  "menu.hideOthers": "Hide Others",
  "menu.showAll": "Show All",
  "menu.quit": "Quit HiveTask",
  "menu.openRepo": "Open Repository…",
  "menu.preferences": "Preferences",
  "menu.toggleStatusbar": "Show Status Bar",
  "menu.copyUrl": "Copy URL",
  "menu.about": "About HiveTask",

  // Status bar
  "statusbar.noRepo": "No repository",
  "statusbar.syncedAt": "Synced {time}",
  "statusbar.ghOk": "gh CLI available",
  "statusbar.ghMissing": "gh CLI not found",
  "statusbar.online": "Online",
  "statusbar.offline": "Offline",
  "statusbar.onlineTitle": "GitHub reachable — click to re-check",
  "statusbar.offlineTitle": "Cannot reach GitHub — showing local cache; click to retry",

  // Panel chrome
  "panel.switchType": "Switch panel type",
  "panel.splitH": "Split left/right",
  "panel.splitV": "Split top/bottom",
  "panel.close": "Close panel",

  // Panel types (dropdown labels)
  "panelTitle.issue.list": "Issues",
  "panelTitle.issue.detail": "Issue detail",
  "panelTitle.pull.list": "Pull requests",
  "panelTitle.pull.detail": "Pull request detail",
  "panelTitle.settings": "Settings",
  "panelTitle.git.history": "Git history",
  "panelTitle.terminal": "Terminal",

  // Git history panel
  "gitHistory.fetch": "Fetch",
  "gitHistory.branches": "Branches",
  "gitHistory.moreBranches": "{n} more branches",
  "gitHistory.collapse": "Collapse",
  "gitHistory.colGraph": "Graph",
  "gitHistory.colDate": "Date",
  "gitHistory.colAuthor": "Author",
  "gitHistory.colCommit": "Commit",
  "gitHistory.parents": "{n} parents",
  "gitHistory.noCommits": "No commits yet",
  "gitHistory.aheadBehind": "ahead {ahead} · behind {behind}",
  "gitHistory.clickToFilter": "Click to show only this branch's history",

  // Terminal panel
  "terminal.exited": "—— shell exited ——",
  "terminal.restart": "Restart",

  // Editor switcher categories
  "editorCat.issues": "Issues",
  "editorCat.pulls": "Pull Requests",
  "editorCat.tools": "Tools",
  "editorCat.general": "General",

  // Panel modes
  "mode.list": "List",
  "mode.milestone": "Milestones",
  "mode.settings.basic": "Basic settings",

  // Issue/PR state (filter tabs + detail badges)
  "state.open": "Open",
  "state.closed": "Closed",
  "state.merged": "Merged",
  "state.all": "All",

  // Settings — basic mode
  "settings.language": "Language",
  "settings.languageDesc": "Interface display language",
  "settings.theme": "Theme",
  "settings.themeDesc": "Color scheme; follows the OS appearance when set to System",
  "settings.themeDark": "Dark",
  "settings.themeLight": "Light",
  "settings.themeSystem": "System",
    "settings.connections": "Source connections",
  "settings.connectionsDesc": "Manage URLs and credentials for GitHub / Gitea / Gitee sources",
  "settings.connectionsManage": "Manage",
  "settings.save": "Save",
  "conn.title": "Source connections",
  "conn.empty": "No source connections yet",
  "conn.add": "+ Add connection",
  "conn.edit": "Edit",
  "conn.delete": "Delete",
  "conn.type": "Type",
  "conn.labelField": "Label",
  "conn.labelPlaceholder": "e.g. Company Gitea",
  "conn.hostField": "URL",
  "conn.tokenField": "Access token",
  "conn.tokenPlaceholder": "Paste an access token (write-only)",
  "conn.ghManaged": "Managed by gh CLI (follows gh auth login)",
  "conn.cancel": "Cancel",
  "conn.save": "Save",
  "conn.saved": "Saved \"{label}\"",
  "conn.credSet": "credentials set",
  "settings.terminalShell": "Terminal shell",
  "settings.terminalShellDesc": "Shell used by the integrated terminal; applies to newly opened terminals",
  "settings.shellAuto": "System default",
  "settings.statusbar": "Show status bar",
  "settings.statusbarDesc": "Show repository and sync status at the bottom of the window",

  // About dialog
  "about.description":
    "An independent project management desktop app — \"Have a task\": manage issues, pull requests and milestones of your GitHub repositories.",
  "about.version": "Current version",
  "about.builtWith": "Built with Vue 3 + Tauri 2",
  "about.license": "Open source (MIT License)",
  "about.libraries": "Third-party libraries",
  "about.copyright": "Copyright © {year} HiveTask Contributors",
  "about.close": "Close",

  // Shared strings
  "list.loading": "Loading…",
  "common.refresh": "Refresh",
  "common.syncing": "Syncing…",
  "common.empty": "No data yet — hit Refresh to fetch from the remote",
  "common.noBody": "(No description)",
  "common.openInGithub": "Open on GitHub",
  "common.loadingFull": "Loading full details from GitHub…",
  "common.draft": "Draft",
  "common.unassignedMilestone": "No milestone",
  "milestone.noneInUse": "This repository doesn't use milestones — shown as a flat list",
  "common.author": "Author: {name}",
  "common.assignees": "Assignees: {name}",
  "common.reviewers": "Reviewers: {name}",
  "common.comments": "{n} comments",
  "common.commits": "{n} commits",

  // Comments (write-through)
  "comments.title": "Comments",
  "comments.empty": "No comments yet",
  "comments.placeholder": "Write a comment — Markdown supported (⌘↵ to send)",
  "comments.send": "Comment",
  "comments.sending": "Sending…",

  // Merge (irreversible — dialog confirm)
  "merge.button": "Merge",
  "merge.working": "Merging…",
  "merge.title": "Merge pull request",
  "merge.hint": "The pull request closes once merged. This cannot be undone.",
  "merge.confirm": "Merge",
  "merge.cancel": "Cancel",
  "merge.merge": "Create a merge commit",
  "merge.mergeDesc": "Keep all branch commits, plus one merge commit",
  "merge.squash": "Squash and merge",
  "merge.squashDesc": "All changes become a single commit on the base branch",
  "merge.rebase": "Rebase and merge",
  "merge.rebaseDesc": "Rebase commits onto the base branch, no merge commit",

  // Detail state actions
  "detail.close": "Close",
  "detail.reopen": "Reopen",
  "detail.closeConfirm": "Click again to close",
  "detail.working": "Working…",

  // Issue workspace
  "issue.emptySelect": "Select an issue on the left to see its details",
  "issue.emptyRepo": "Choose a local Git repository, then refresh issues",

  // Pull request workspace
  "pull.emptySelect": "Select a pull request on the left to see its details",
  "pull.emptyRepo": "Choose a local Git repository, then refresh pull requests",

  // GitHub reviewDecision values
  "review.approved": "Approved",
  "review.reviewRequired": "Review required",
  "review.changesRequested": "Changes requested",

  // Errors surfaced in the panel banner
  "error.browserPreview": "gh cannot be called in browser preview — run inside the Tauri window",

  // gh error translations (raw output kept as toast detail)
  "error.permission": "This account doesn't have permission to do that",
  "error.notFound": "Not found — it may have been deleted or the number is wrong",
  "error.auth": "gh authentication failed — run `gh auth login` in a terminal",
  "error.rateLimit": "GitHub API rate limited — try again later",
  "error.locked": "This conversation is locked — commenting is disabled",
  "error.repo": "Git repository or remote not found — make sure the right folder is selected",
  "error.network": "Network error — cannot reach GitHub",
};
