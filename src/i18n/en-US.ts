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
  "lang.switch": "Switch language",
  "theme.switch": "Toggle light / dark theme",

  // Menus
  "menu.file": "File",
  "menu.view": "View",
  "menu.tools": "Tools",
  "menu.help": "Help",
  "menu.issues": "Issues",
  "menu.pulls": "Pull Requests",
  "menu.openRepo": "Open Repository…",
  "menu.preferences": "Preferences",
  "menu.toggleStatusbar": "Show Status Bar",
  "menu.copyUrl": "Copy URL",
  "menu.about": "About HiveTask",

  // Status bar
  "statusbar.noRepo": "No repository",
  "statusbar.syncedAt": "Synced at {time}",
  "statusbar.ghOk": "gh CLI available",
  "statusbar.ghMissing": "gh CLI not found",

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

  // Panel modes
  "mode.list": "List",
  "mode.milestone": "Milestones",
  "mode.settings.basic": "Basic settings",

  // Settings — basic mode
  "settings.language": "Language",
  "settings.languageDesc": "Interface display language",
  "settings.theme": "Theme",
  "settings.themeDesc": "Color scheme; follows the OS appearance when set to System",
  "settings.themeDark": "Dark",
  "settings.themeLight": "Light",
  "settings.themeSystem": "System",
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
  "common.refresh": "Refresh",
  "common.syncing": "Syncing…",
  "common.empty": "No data yet — hit Refresh to fetch from GitHub",
  "common.noBody": "(No description)",
  "common.openInGithub": "Open on GitHub",
  "common.loadingFull": "Loading full details from GitHub…",
  "common.draft": "Draft",
  "common.merged": "Merged",
  "common.unassignedMilestone": "No milestone",
  "common.author": "Author: {name}",
  "common.assignees": "Assignees: {name}",
  "common.reviewers": "Reviewers: {name}",
  "common.comments": "{n} comments",
  "common.commits": "{n} commits",

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
};
