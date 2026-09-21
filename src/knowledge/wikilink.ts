/**
 * wikilink 前端工具（纯函数，无 DOM / store 依赖）——编辑器补全、点击跳转
 * 共用。语义镜像 src-tauri/src/kb_graph.rs 的 `wikilink_target` /
 * `resolve_target`（两处同步维护，Rust 侧有单测锚定口径）。
 */

/** `[[目标|别名]]` / `[[目标#小节]]` → 目标（trim 后可能为空 = 同文件锚点）。 */
export function wikilinkTargetOf(raw: string): string {
  return (raw.split("|")[0] ?? "").split("#")[0].trim();
}

export function fileStemOf(rel: string): string {
  const name = rel.split("/").pop() ?? rel;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function parentDirOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(0, idx) : "";
}

export interface NoteIndex {
  /** 全部 md 相对路径（正斜杠）。 */
  rels: Set<string>;
  /** 文件名（去扩展名）→ rel 列表；唯一才可兜底消解。 */
  byStem: Map<string, string[]>;
}

export function buildNoteIndex(rels: string[]): NoteIndex {
  const md = rels.filter((r) => r.toLowerCase().endsWith(".md") || r.toLowerCase().endsWith(".markdown"));
  const byStem = new Map<string, string[]>();
  for (const rel of md) {
    const stem = fileStemOf(rel);
    const list = byStem.get(stem);
    if (list) list.push(rel);
    else byStem.set(stem, [rel]);
  }
  return { rels: new Set(md), byStem };
}

/** 段级归一：处理 `.` / `..`；越出根 → null。 */
function normalizeRelPath(dir: string, target: string): string | null {
  const stack: string[] = dir ? dir.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!stack.pop()) return null;
    } else {
      stack.push(seg);
    }
  }
  return stack.join("/");
}

/**
 * 目标消解：库根相对（原样 / 补 .md）→ 源文件目录相对 → 文件名唯一兜底。
 * 歧义（同名多文件）与未命中 → null。fromRel 为 null 时跳过目录相对一路。
 */
export function resolveWikilink(raw: string, fromRel: string | null, index: NoteIndex): string | null {
  const t = raw.trim().replace(/^\.?\//, "").replaceAll("\\", "/");
  if (!t || t.startsWith("/") || t.includes(":")) return null;
  const dir = fromRel ? parentDirOf(fromRel) : "";
  for (const candidate of [t, `${t}.md`]) {
    if (index.rels.has(candidate)) return candidate;
    const joined = normalizeRelPath(dir, candidate);
    if (joined !== null && index.rels.has(joined)) return joined;
  }
  const hits = index.byStem.get(fileStemOf(t));
  return hits && hits.length === 1 ? hits[0] : null;
}

/** 补全候选项：stem + 归属目录（detail 展示用）。 */
export interface NoteCandidate {
  label: string;
  detail: string;
  rel: string;
}

export function noteCandidates(index: NoteIndex): NoteCandidate[] {
  return [...index.rels]
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .map((rel) => {
      const dir = parentDirOf(rel);
      return { label: fileStemOf(rel), detail: dir, rel };
    });
}
