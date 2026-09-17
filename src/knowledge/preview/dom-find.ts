/**
 * 共享的 **DOM 文本查找**：给"渲染成 HTML 的只读预览"用一套实现
 * （docx / xlsx / pptx / epub / ofd / xps / 邮件 / 代码 / 压缩包…）。
 *
 * 两条实现约束：
 * 1. **高亮用 `<mark>` 包裹，不用 CSS Custom Highlight API** —— 后者是 Safari 17.2+，
 *    而应用跑在 WKWebView 里，特性集合比同机 Safari 还保守（`Iterator` 那个坑的同类）；
 * 2. 命中可能**跨越多个文本节点**（`<p>河<strong>南</strong>神马</p>` 里搜"河南"），
 *    所以先把容器内所有文本节点拼成一条字符串并记下偏移，再按命中区间分段包裹；
 *    跨节点的命中会在每个节点里各插一个 `<mark>`，用 `data-hit` 归到同一次命中。
 *
 * 清理时把 `<mark>` 拆回纯文本节点并 `normalize()`，DOM 回到查找前的样子（不留痕迹）。
 */
import type { PreviewContext, PreviewInstance } from "./registry";

/**
 * 给"渲染成 HTML 的只读预览"接上共享查找（docx/xlsx/pptx/epub/邮件/代码…都用这一个）。
 * 它只看 `ctx.container` 里的文本节点，与具体渲染器无关。
 */
export function withFind(ctx: PreviewContext, extra?: Partial<PreviewInstance>): PreviewInstance {
  const finder = new DomFinder(ctx.container);
  return {
    ...extra,
    find: async (query, options) => finder.find(query, options),
    findClear: () => finder.clear(),
    destroy: () => {
      finder.clear();
      extra?.destroy?.();
    },
  };
}

export interface DomFindOptions {
  forward: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
}

export interface DomFindResult {
  total: number;
  current: number;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);

export class DomFinder {
  /** 命中组：每组 = 同一次命中的若干 `<mark>`（跨节点时多于一个）。 */
  private hits: HTMLElement[][] = [];
  private current = 0;
  private key = "";

  constructor(private readonly container: HTMLElement) {}

  /** 反查文本节点（跳过脚本/样式与已有高亮）。 */
  private textNodes(): Text[] {
    const walker = document.createTreeWalker(this.container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return (node as Text).data ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return nodes;
  }

  /** 抹掉上次的高亮（拆 mark 后合并相邻文本节点）。 */
  clearMarks(): void {
    for (const group of this.hits) {
      for (const mark of group) {
        const parent = mark.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
        parent.normalize();
      }
    }
    this.hits = [];
    this.current = 0;
  }

  /** 按查询词扫一遍并高亮，返回命中总数（`current` 停在第一个）。 */
  search(query: string, options: { caseSensitive?: boolean; wholeWord?: boolean; regexp?: boolean }): number {
    this.clearMarks();
    this.key = "";
    const needle = query.trim();
    if (!needle) return 0;

    const nodes = this.textNodes();
    const flat = nodes.map((node) => node.data).join("");
    if (!flat) return 0;

    // 定位命中区间：普通模式用 indexOf；正则模式让用户说了算（无效正则当作无命中）
    const ranges: { start: number; end: number }[] = [];
    if (options.regexp) {
      let re: RegExp;
      try {
        re = new RegExp(needle, options.caseSensitive ? "g" : "gi");
      } catch {
        return 0;
      }
      for (let hit = re.exec(flat); hit; hit = re.exec(flat)) {
        if (hit[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        ranges.push({ start: hit.index, end: hit.index + hit[0].length });
      }
    } else {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = options.wholeWord ? `\\b${escaped}\\b` : escaped;
      const re = new RegExp(pattern, options.caseSensitive ? "g" : "gi");
      for (let hit = re.exec(flat); hit; hit = re.exec(flat)) {
        ranges.push({ start: hit.index, end: hit.index + hit[0].length });
      }
    }
    if (!ranges.length) return 0;

    // 把区间映射回文本节点：跨节点时在各自节点里分别包 mark
    let cursor = 0;
    for (const node of nodes) {
      const nodeStart = cursor;
      const nodeEnd = cursor + node.data.length;
      cursor = nodeEnd;
      const overlapping = ranges.filter((range) => range.end > nodeStart && range.start < nodeEnd);
      if (!overlapping.length) continue;

      // 从后往前切，避免前面的插入影响后面的偏移
      for (const range of [...overlapping].reverse()) {
        const from = Math.max(range.start, nodeStart) - nodeStart;
        const to = Math.min(range.end, nodeEnd) - nodeStart;
        // splitText 就地拆成 前缀 | 命中 | 尾部（尾部留在原位置，不进 mark）
        node.splitText(to);
        const matched = node.splitText(from);
        const mark = document.createElement("mark");
        mark.className = "kb-hit";
        mark.dataset.hit = String(ranges.indexOf(range));
        // 插在命中段之前再把它包进去 —— 直接 replaceChild 会把命中文本丢掉
        matched.parentNode?.insertBefore(mark, matched);
        mark.appendChild(matched);
      }
    }

    const byHit = new Map<string, HTMLElement[]>();
    for (const mark of Array.from(this.container.querySelectorAll<HTMLElement>("mark.kb-hit"))) {
      const id = mark.dataset.hit ?? "0";
      byHit.set(id, [...(byHit.get(id) ?? []), mark]);
    }
    this.hits = [...byHit.keys()]
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => byHit.get(id)!);
    this.current = this.hits.length ? 1 : 0;
    this.key = `${options.caseSensitive ? "cs" : "ci"}|${options.wholeWord ? "ww" : ""}|${options.regexp ? "re" : ""}|${needle}`;
    this.highlightCurrent();
    return this.hits.length;
  }

  /** 下一个/上一个（含回绕），并把当前命中滚进视野。 */
  step(options: DomFindOptions): DomFindResult {
    if (!this.hits.length) return { total: 0, current: 0 };
    this.current = options.forward
      ? (this.current % this.hits.length) + 1
      : ((this.current - 2 + this.hits.length) % this.hits.length) + 1;
    this.highlightCurrent();
    return { total: this.hits.length, current: this.current };
  }

  /** 查询词与开关都没变时，只移动当前命中；变了就重扫（面板每次输入都会调这里）。 */
  find(query: string, options: DomFindOptions): DomFindResult {
    const key = `${options.caseSensitive ? "cs" : "ci"}|${options.wholeWord ? "ww" : ""}|${options.regexp ? "re" : ""}|${query.trim()}`;
    if (key === this.key && this.hits.length) return this.step(options);
    if (!query.trim()) {
      this.clearMarks();
      this.key = "";
      return { total: 0, current: 0 };
    }
    const total = this.search(query, options);
    return { total, current: this.current };
  }

  /** 清空高亮（关闭查找条时调用）。 */
  clear(): void {
    this.clearMarks();
    this.key = "";
  }

  private highlightCurrent(): void {
    for (const [index, group] of this.hits.entries()) {
      const active = index === this.current - 1;
      for (const mark of group) mark.classList.toggle("kb-hit-current", active);
      if (!active) continue;
      // 有的 DOM 宿主（jsdom 等）没有 scrollIntoView —— 滚动只是体验，不该让查找失败
      group[0]?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }
  }
}
