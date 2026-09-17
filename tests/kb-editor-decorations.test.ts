/**
 * 编辑器两个装饰器插件的**纯逻辑**测试（不需要 DOM / 真机）：
 *
 * - live-preview：光标所在行的记号**显形**、其它行记号**隐藏**；标题行拿到行装饰。
 *   这是"Typora 式"的核心行为，也是 T6 里最容易被改坏的地方。
 * - math-diagram：行内/块级公式被替换成 KaTeX widget；代码块内的 `$` **不**被识别；
 *   ```mermaid 围栏被替换成 Mermaid widget。
 *
 * 渲染结果（KaTeX/Mermaid 真出图）需要真机，不在这里覆盖。
 */
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { buildDecorations } from "../src/knowledge/editor/live-preview";
import {
  KatexWidget,
  MermaidWidget,
  mathAndDiagramDecorations,
} from "../src/knowledge/editor/math-diagram";

function stateAt(doc: string, cursor: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    // 与编辑器同款配置：GFM（表格/待办/删除线）
    extensions: [markdown({ extensions: [GFM] })],
  });
}

interface Deco {
  from: number;
  to: number;
  widget?: unknown;
  isReplace: boolean;
  lineClass?: string;
}

function collect(set: ReturnType<typeof buildDecorations>): Deco[] {
  const out: Deco[] = [];
  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec as { widget?: unknown };
    out.push({
      from: iter.from,
      to: iter.to,
      widget: spec.widget,
      isReplace: iter.value.point === false && iter.to > iter.from,
      lineClass: (iter.value as unknown as { spec: { class?: string } }).spec?.class,
    });
    iter.next();
  }
  return out;
}

describe("live-preview 标记显隐", () => {
  const doc = "# 标题一\n\n正文 **粗体** 与 *斜体*。\n";

  it("光标在其它行 → 标题行的记号被隐藏；光标所在行的记号保持显形", () => {
    const set = buildDecorations(stateAt(doc, doc.indexOf("正文")));
    const hidden = collect(set).filter((d) => d.to > d.from);
    // 标题行的 `#` 隐藏
    expect(hidden.some((d) => d.from === 0 && d.to === 1)).toBe(true);
    // 正文行（光标所在）的 `**` / `*` 不隐藏：整行可见才可编辑
    const boldStart = doc.indexOf("**");
    expect(hidden.some((d) => d.from === boldStart && d.to === boldStart + 2)).toBe(false);
  });

  it("光标进入标题行 → 该行记号显形（不再隐藏 `#`）", () => {
    const set = buildDecorations(stateAt(doc, 2));
    const hidden = collect(set).filter((d) => d.to > d.from);
    expect(hidden.some((d) => d.from === 0 && d.to === 1)).toBe(false);
  });

  it("标题行拿到块级行装饰（字号靠它变大）", () => {
    const set = buildDecorations(stateAt(doc, doc.indexOf("正文")));
    const lines = collect(set).filter((d) => d.lineClass?.startsWith("cm-md-h"));
    expect(lines.length).toBe(1);
    expect(lines[0].lineClass).toBe("cm-md-h1");
  });
});

describe("公式与图表的块级替换", () => {
  it("行内公式 → KaTeX widget（非 display）", () => {
    const doc = "质能方程 $E = mc^2$ 结束。\n";
    const decos = collect(mathAndDiagramDecorations(stateAt(doc, doc.length)));
    const katex = decos.find((d) => d.widget instanceof KatexWidget) as
      | (Deco & { widget: KatexWidget })
      | undefined;
    expect(katex).toBeTruthy();
    expect(katex!.widget.tex).toBe("E = mc^2");
    expect(katex!.widget.display).toBe(false);
  });

  it("独行 $$…$$ → display 模式", () => {
    const doc = "$$\na = b\n$$\n";
    const decos = collect(mathAndDiagramDecorations(stateAt(doc, doc.length)));
    const katex = decos.find((d) => d.widget instanceof KatexWidget) as
      | (Deco & { widget: KatexWidget })
      | undefined;
    expect(katex).toBeTruthy();
    expect(katex!.widget.display).toBe(true);
  });

  it("代码块里的 $ 不被当成公式", () => {
    const doc = "```sh\n echo $HOME\n```\n";
    const decos = collect(mathAndDiagramDecorations(stateAt(doc, doc.length)));
    expect(decos.some((d) => d.widget instanceof KatexWidget)).toBe(false);
  });

  it("```mermaid 围栏 → Mermaid widget（携带源代码）", () => {
    const doc = "```mermaid\ngraph LR\n A-->B\n```\n";
    const decos = collect(mathAndDiagramDecorations(stateAt(doc, doc.length)));
    const mmd = decos.find((d) => d.widget instanceof MermaidWidget) as
      | (Deco & { widget: MermaidWidget })
      | undefined;
    expect(mmd).toBeTruthy();
    expect(mmd!.widget.source).toBe("graph LR\n A-->B");
  });

  it("光标进入公式块 → 回到源码（不替换）", () => {
    const doc = "质能方程 $E = mc^2$ 结束。\n";
    const decos = collect(mathAndDiagramDecorations(stateAt(doc, 6)));
    expect(decos.some((d) => d.widget instanceof KatexWidget)).toBe(false);
  });
});

describe("行内 widget：圆点 / 待办 / 分隔线", () => {
  const doc = "- 项一\n- [ ] 待办\n- [x] 已完成\n\n---\n\n1. 有序\n";

  it("无序列表标记换成圆点，有序列表保持数字", () => {
    const decos = collect(buildDecorations(stateAt(doc, doc.length)));
    const bullets = decos.filter((d) => (d.widget as { toDOM?: unknown } | undefined));
    // 三处替换：项一 / 待办 / 已完成 的标记（有序列表的 "1." 不替换）
    expect(bullets.some((d) => d.from === 0 && d.to === 1)).toBe(true);
    expect(bullets.some((d) => d.from === doc.indexOf("1.") && d.to === doc.indexOf("1.") + 2)).toBe(false);
  });

  it("待办项连标记带方括号一起替换（点一下可切换）", () => {
    const decos = collect(buildDecorations(stateAt(doc, doc.length)));
    const taskFrom = doc.indexOf("- [ ]");
    const task = decos.find((d) => d.from === taskFrom);
    expect(task).toBeTruthy();
    expect(task!.to).toBe(taskFrom + 5, "覆盖 `- [ ]` 五个字符");
    expect((task!.widget as { checked?: boolean }).checked).toBe(false);
  });

  it("已完成项的复选框为勾选态", () => {
    const decos = collect(buildDecorations(stateAt(doc, doc.length)));
    const doneFrom = doc.indexOf("- [x]");
    const done = decos.find((d) => d.from === doneFrom);
    expect((done!.widget as { checked?: boolean }).checked).toBe(true);
  });

  it("光标在列表行 → 该行保持源码（可编辑）", () => {
    const decos = collect(buildDecorations(stateAt(doc, 3)));
    expect(decos.some((d) => d.from === 0 && d.to === 1)).toBe(false);
  });

  it("分隔线整行替换成线条", () => {
    const decos = collect(buildDecorations(stateAt(doc, doc.length)));
    const ruleFrom = doc.indexOf("---");
    expect(decos.some((d) => d.from === ruleFrom && d.to === ruleFrom + 3)).toBe(true);
  });
});

describe("表格 widget", () => {
  const doc = "| 名称 | 值 |\n|:---|---:|\n| 甲 | **1** |\n| 乙 | `2` |\n\n尾段\n";

  it("表格整体替换为 table widget（光标在表外）", async () => {
    const { TableWidget } = await import("../src/knowledge/editor/table");
    // 表格是**跨行块级**替换：由 state facet（mathAndDiagramDecorations）提供
    const decos = collect(mathAndDiagramDecorations(stateAt(doc, doc.length)));
    const table = decos.find((d) => d.widget instanceof TableWidget);
    expect(table).toBeTruthy();
    expect(table!.from).toBe(0, "从表格首行开始");
    expect(table!.widget).toHaveProperty("source");
  });

  it("光标进入表格 → 回到源码", async () => {
    const { TableWidget } = await import("../src/knowledge/editor/table");
    const decos = collect(mathAndDiagramDecorations(stateAt(doc, 3)));
    expect(decos.some((d) => d.widget instanceof TableWidget)).toBe(false);
  });
});

describe("表格解析（纯函数）", () => {
  it("表头 / 对齐 / 单元格切分", async () => {
    const { parseTable } = await import("../src/knowledge/editor/table");
    const parsed = parseTable("| 名称 | 值 | 备注 |\n|:---|:---:|---:|\n| 甲 | 1 | x |\n| 乙 | 2 | y |");
    expect(parsed).toBeTruthy();
    expect(parsed!.header).toEqual(["名称", "值", "备注"]);
    expect(parsed!.align).toEqual(["left", "center", "right"]);
    expect(parsed!.rows).toEqual([
      ["甲", "1", "x"],
      ["乙", "2", "y"],
    ]);
  });

  it("转义竖线与参差行", async () => {
    const { parseTable } = await import("../src/knowledge/editor/table");
    const parsed = parseTable("| a | b |\n|---|---|\n| x \\| y |\n");
    expect(parsed!.rows[0]).toEqual(["x | y", ""], "转义竖线保留为字面量，缺列补齐");
  });

  it("不是表格的管道文本返回 null", async () => {
    const { parseTable } = await import("../src/knowledge/editor/table");
    expect(parseTable("| 只是一行 |")).toBeNull();
  });

  it("单元格内容按 inline Markdown 渲染（粗体/行内代码）", async () => {
    const { parseTable, renderTableHtml } = await import("../src/knowledge/editor/table");
    const html = renderTableHtml(parseTable("| h |\n|:---|\n| **粗** 与 `码` |")!);
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<code>码</code>");
    expect(html).toContain('style="text-align:left"');
  });
});

describe("图片渲染", () => {
  it("本地相对图片路径按文档目录解析", async () => {
    const { resolveImageRel } = await import("../src/knowledge/editor/image");
    expect(resolveImageRel("docs/note.md", "img/a.png")).toBe("docs/img/a.png");
    expect(resolveImageRel("docs/note.md", "./img/a.png")).toBe("docs/img/a.png");
    expect(resolveImageRel("docs/sub/note.md", "../img/a.png")).toBe("docs/img/a.png");
    expect(resolveImageRel("README.md", "docs/a.png")).toBe("docs/a.png");
    expect(resolveImageRel("docs/note.md", ".././x.png")).toBe("x.png");
  });

  it("图片被替换为 Image widget（光标在外），光标进入回到源码", async () => {
    const { ImageWidget } = await import("../src/knowledge/editor/image");
    const doc = "前文 ![徽标](docs/logo.png) 后文\n";
    const outside = collect(buildDecorations(stateAt(doc, doc.length)));
    expect(outside.some((d) => d.widget instanceof ImageWidget)).toBe(true);

    const inside = collect(buildDecorations(stateAt(doc, 8)));
    expect(inside.some((d) => d.widget instanceof ImageWidget)).toBe(false);
  });
});
