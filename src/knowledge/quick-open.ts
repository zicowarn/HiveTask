/**
 * ⌘P 快速打开：模糊匹配与排序（纯函数，便于单测）。
 *
 * 匹配口径照 VS Code：**路径的子序列匹配**，但要求字符顺序一致；
 * 排序偏好：文件名命中 > 路径命中、连续命中 > 分散命中、越靠前越好、路径越短越好。
 * 空查询时给"最近打开"（这是 ⌘P 最常用的用法：不是找，是回到刚才那个文件）。
 */
export interface QuickOpenItem {
  rel: string;
  /** 展示用：文件名 + 相对路径（两行式，文件名高亮）。 */
  name: string;
  dir: string;
  score: number;
}

/** 文件名（路径末段）。 */
function baseName(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at < 0 ? rel : rel.slice(at + 1);
}

function dirOf(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at < 0 ? "" : rel.slice(0, at);
}

/**
 * 子序列打分：返回 null = 不匹配。
 * 计分（越大越好）：连续命中 +8、词首/路径段首命中 +6、基础命中 +1，位置越靠后扣分。
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let cursor = 0;
  let lastHit = -2;
  for (const char of needle) {
    const at = haystack.indexOf(char, cursor);
    if (at < 0) return null;
    score += 1;
    if (at === lastHit + 1) score += 8; // 连续
    if (at === 0 || "/-_ .".includes(haystack[at - 1] ?? "")) score += 6; // 词首/段首
    score -= Math.min(at, 20) * 0.1; // 越靠前越好
    lastHit = at;
    cursor = at + 1;
  }
  return score;
}

/**
 * 排序：先按"文件名命中"整体加权，再按模糊分；同分时短路径优先。
 * `recents` 里的路径在**空查询**时直接置顶，在**有查询**时只做小幅加权（不喧宾夺主）。
 */
export function rankFiles(files: string[], query: string, recents: string[] = [], limit = 50): QuickOpenItem[] {
  const recentIndex = new Map(recents.map((rel, index) => [rel, index]));
  const trimmed = query.trim();

  if (!trimmed) {
    const ordered = [...recents.filter((rel) => files.includes(rel)), ...files.filter((rel) => !recentIndex.has(rel))];
    return ordered.slice(0, limit).map((rel) => ({
      rel,
      name: baseName(rel),
      dir: dirOf(rel),
      score: 0,
    }));
  }

  const items: QuickOpenItem[] = [];
  for (const rel of files) {
    const name = baseName(rel);
    const nameScore = fuzzyScore(name, trimmed);
    const pathScore = fuzzyScore(rel, trimmed);
    if (nameScore === null && pathScore === null) continue;
    // 文件名命中权重更高：找 "note" 时应先给 note.md，而不是 a/note/b.md
    let score = (nameScore ?? -Infinity) * 2 + (pathScore ?? -Infinity);
    const recent = recentIndex.get(rel);
    if (recent !== undefined) score += Math.max(0, 6 - recent);
    score -= rel.length * 0.01; // 同分时短的更靠前
    items.push({ rel, name, dir: dirOf(rel), score });
  }
  items.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel, "zh-Hans-CN"));
  return items.slice(0, limit);
}
