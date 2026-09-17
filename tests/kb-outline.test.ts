// @vitest-environment jsdom
/**
 * 大纲：标题提取（语法树，代码块里的 `#` 不算）+ 当前章节判定。
 * 用真 EditorState，避免正则式实现的漏判（例如围栏内的 # 被当成标题）。
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { activeOutlineIndex, buildOutline } from "../src/knowledge/editor/outline";

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
}

const DOC = `# 一级标题

正文。

## 二级 A

\`\`\`sh
# 这是代码里的井号，不是标题
\`\`\`

### 三级

## 二级 B
`;

describe("大纲提取", () => {
  it("按顺序给出标题与层级", () => {
    const items = buildOutline(stateOf(DOC));
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, "一级标题"],
      [2, "二级 A"],
      [3, "三级"],
      [2, "二级 B"],
    ]);
  });

  it("行号是 0 基且能对上文档", () => {
    const items = buildOutline(stateOf(DOC));
    const doc = stateOf(DOC).doc;
    for (const item of items) {
      expect(doc.line(item.line + 1).text).toContain(item.text);
    }
  });

  it("代码块里的 # 不算标题", () => {
    const items = buildOutline(stateOf(DOC));
    expect(items.some((i) => i.text.includes("不是标题"))).toBe(false);
  });

  it("去掉行首记号与结尾井号", () => {
    const items = buildOutline(stateOf("## 标题 ##\n"));
    expect(items[0].text).toBe("标题");
  });

  it("无标题文档返回空", () => {
    expect(buildOutline(stateOf("只有正文。\n"))).toEqual([]);
  });
});

describe("当前章节判定", () => {
  const items = buildOutline(stateOf(DOC));

  it("光标在某标题之后 → 命中最近的上一级", () => {
    // 三级标题在第 10 行（0 基）：它本身与其后的空行都应高亮"三级"
    expect(activeOutlineIndex(items, 10)).toBe(2);
    expect(activeOutlineIndex(items, 11)).toBe(2);
    // 第 12 行是"二级 B"自己 —— 应命中最后一项
    expect(activeOutlineIndex(items, 12)).toBe(3);
  });

  it("光标在首个标题之前 → 无高亮", () => {
    expect(activeOutlineIndex(items, -1)).toBe(-1);
  });

  it("光标在二级 B 处 → 命中它", () => {
    const last = items[items.length - 1];
    expect(activeOutlineIndex(items, last.line)).toBe(items.length - 1);
  });
});
