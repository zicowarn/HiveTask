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

  // Panel modes
  "mode.list": "List",
  "mode.milestone": "Milestones",

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
