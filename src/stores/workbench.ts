/**
 * Workbench layout store.
 *
 * Each workspace owns a binary layout tree: leaves are panels (referenced
 * by registry panel type), split nodes hold direction/ratio and two
 * children. The tree is rendered recursively by WorkbenchNode and can be
 * reshaped at runtime — split a leaf into two panes or close a pane
 * (its sibling takes its place). Trees persist per workspace in
 * localStorage, so the layout survives restarts.
 *
 * Leaf ids are unique across all workspaces, so split/close actions locate
 * their target without needing an active-workspace parameter.
 */
import { defineStore } from "pinia";
import { durableGet, durableSet } from "../ui-prefs";
import { ref, watch } from "vue";
import { workspaces } from "../workbench/workspaces";
import { panelTypes } from "../workbench/panel-types";

export interface LeafNode {
  id: string;
  type: "leaf";
  panel: string;
}

export interface SplitNode {
  id: string;
  type: "split";
  dir: "h" | "v";
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

const STORAGE_KEY = "hivetask.workbench-layout-v1";

// Every registered panel type is reachable via the Editor type switcher and
// may appear in a persisted layout; used to reject stale or hand-edited blobs
// referencing a removed panel type.
const allowedPanels = new Set(panelTypes.map((p) => p.type));

let idCounter = 0;
function uid(): string {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 6)}`;
}

function makeLeaf(panel: string): LeafNode {
  return { id: uid(), type: "leaf", panel };
}

function defaultLayout(ws: (typeof workspaces)[number]): LayoutNode {
  // 单面板工作区（如 projects 的看板）默认整区一叶，不强拆两栏。
  if (ws.listPanel === ws.detailPanel) return makeLeaf(ws.listPanel);
  return {
    id: uid(),
    type: "split",
    dir: "h",
    ratio: 0.38,
    first: makeLeaf(ws.listPanel),
    second: makeLeaf(ws.detailPanel),
  };
}

function isNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.type === "leaf") {
    return typeof node.id === "string" && allowedPanels.has(node.panel as string);
  }
  if (node.type === "split") {
    return (
      typeof node.id === "string" &&
      (node.dir === "h" || node.dir === "v") &&
      typeof node.ratio === "number" &&
      isNode(node.first) &&
      isNode(node.second)
    );
  }
  return false;
}

function defaultLayouts(): Record<string, LayoutNode> {
  return Object.fromEntries(workspaces.map((w) => [w.key, defaultLayout(w)]));
}

function loadLayouts(): Record<string, LayoutNode> {
  const layouts = defaultLayouts();
  try {
    const raw = durableGet(STORAGE_KEY);
    if (!raw) return layouts;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const ws of workspaces) {
      const saved = parsed[ws.key];
      if (isNode(saved)) layouts[ws.key] = saved;
    }
  } catch {
    // Corrupt blob or unavailable storage — keep the fresh default layouts.
  }
  return layouts;
}

/** Walk result for a leaf: its parent split plus the slot holding it. */
interface LeafLocation {
  wsKey: string;
  root: LayoutNode;
  parent: SplitNode | null;
}

export const useWorkbenchStore = defineStore("workbench", () => {
  const layouts = ref<Record<string, LayoutNode>>(loadLayouts());

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persist() {
    try {
      durableSet(STORAGE_KEY, JSON.stringify(layouts.value));
    } catch {
      // Storage full or unavailable — layout changes still apply this session.
    }
  }
  watch(
    layouts,
    () => {
      // Dragging a divider mutates ratio rapidly; coalesce the writes.
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 250);
    },
    { deep: true },
  );

  function locateLeaf(leafId: string): LeafLocation | null {
    for (const wsKey of Object.keys(layouts.value)) {
      const root = layouts.value[wsKey];
      if (root.type === "leaf") {
        if (root.id === leafId) return { wsKey, root, parent: null };
        continue;
      }
      const walk = (node: LayoutNode, parent: SplitNode): SplitNode | null => {
        if (node.type === "leaf") return node.id === leafId ? parent : null;
        return walk(node.first, node) ?? walk(node.second, node);
      };
      const parent = walk(root.first, root) ?? walk(root.second, root);
      if (parent) return { wsKey, root, parent };
    }
    return null;
  }

  function countLeaves(node: LayoutNode): number {
    return node.type === "leaf" ? 1 : countLeaves(node.first) + countLeaves(node.second);
  }

  function canCloseLeaf(leafId: string): boolean {
    const loc = locateLeaf(leafId);
    return !!loc && loc.parent !== null;
  }

  /** Replace a leaf with a fresh split containing the leaf plus its clone. */
  function splitLeaf(leafId: string, dir: "h" | "v"): void {
    const loc = locateLeaf(leafId);
    if (!loc || !loc.parent) {
      // Splitting the root leaf: build a new root around it.
      if (loc && loc.root.type === "leaf") {
        layouts.value[loc.wsKey] = {
          id: uid(),
          type: "split",
          dir,
          ratio: 0.5,
          first: loc.root,
          second: makeLeaf(loc.root.panel),
        };
      }
      return;
    }
    const leaf = loc.parent.first.id === leafId ? loc.parent.first : loc.parent.second;
    if (leaf.type !== "leaf") return;
    const replacement: SplitNode = {
      id: uid(),
      type: "split",
      dir,
      ratio: 0.5,
      first: leaf,
      second: makeLeaf(leaf.panel),
    };
    if (loc.parent.first.id === leafId) loc.parent.first = replacement;
    else loc.parent.second = replacement;
  }

  /** Close a pane; its sibling inherits its slot. The last leaf stays. */
  function closeLeaf(leafId: string): void {
    const loc = locateLeaf(leafId);
    if (!loc || !loc.parent) return;
    const isFirst = loc.parent.first.type === "leaf" && loc.parent.first.id === leafId;
    const isSecond = loc.parent.second.type === "leaf" && loc.parent.second.id === leafId;
    // locateLeaf only matches leaves, so one of the two slots is the target.
    if (!isFirst && !isSecond) return;
    const sibling = isFirst ? loc.parent.second : loc.parent.first;

    const grand = findParent(loc.root, loc.parent.id);
    if (!grand) {
      layouts.value[loc.wsKey] = sibling;
    } else if (grand.first.id === loc.parent.id) {
      grand.first = sibling;
    } else {
      grand.second = sibling;
    }
  }

  function findParent(node: LayoutNode, splitId: string): SplitNode | null {
    if (node.type === "leaf") return null;
    if (node.first.type === "split" && node.first.id === splitId) return node;
    if (node.second.type === "split" && node.second.id === splitId) return node;
    return findParent(node.first, splitId) ?? findParent(node.second, splitId);
  }

  /** Replace a leaf's panel type in place (Editor type switcher). */
  function setLeafPanel(leafId: string, panel: string): void {
    if (!allowedPanels.has(panel)) return;
    for (const root of Object.values(layouts.value)) {
      const walk = (node: LayoutNode): boolean => {
        if (node.type === "leaf") {
          if (node.id === leafId) {
            node.panel = panel;
            return true;
          }
          return false;
        }
        return walk(node.first) || walk(node.second);
      };
      if (walk(root)) return;
    }
  }

  /** Set a split node's ratio (divider drag); walks every workspace tree. */
  function setRatio(splitId: string, ratio: number): void {
    const clamped = Math.min(0.82, Math.max(0.18, ratio));
    for (const root of Object.values(layouts.value)) {
      const walk = (node: LayoutNode): boolean => {
        if (node.type === "split") {
          if (node.id === splitId) {
            node.ratio = clamped;
            return true;
          }
          return walk(node.first) || walk(node.second);
        }
        return false;
      };
      if (walk(root)) return;
    }
  }

  /** First leaf of a workspace, for menu actions with no focused pane. */
  function firstLeafId(wsKey: string): string | null {
    const root = layouts.value[wsKey];
    const walk = (node: LayoutNode): string | null =>
      node.type === "leaf" ? node.id : (walk(node.first) ?? walk(node.second));
    return root ? walk(root) : null;
  }

  function resetWorkspace(wsKey: string): void {
    const ws = workspaces.find((w) => w.key === wsKey);
    if (ws) layouts.value[wsKey] = defaultLayout(ws);
  }

  return {
    layouts,
    canCloseLeaf,
    splitLeaf,
    closeLeaf,
    setLeafPanel,
    setRatio,
    firstLeafId,
    countLeaves,
    resetWorkspace,
  };
});
