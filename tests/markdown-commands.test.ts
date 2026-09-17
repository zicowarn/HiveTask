// @vitest-environment jsdom
/**
 * CM6 命令执行：包裹 / 行首前缀 / 整块插入三条路径的真实行为
 * （用真 EditorView，不是纯函数模拟——选区与撤销历史都在状态里）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { runCommandByKey } from "../src/knowledge/editor/commands";
import { commandByKey } from "../src/components/markdown-tools";

const created: EditorView[] = [];
afterEach(() => {
  // 及时销毁：jsdom 下 CM6 的 measure 循环会在测试结束后继续跑并抛未处理异常
  while (created.length) created.pop()?.destroy();
});

function view(doc: string, anchor: number, head = anchor): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const instance = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [markdown({ extensions: [GFM] }), history()],
    }),
    parent: host,
  });
  created.push(instance);
  return instance;
}

describe("CM6 Markdown 命令", () => {
  it("粗体：空选区插入占位并选中，便于直接输入", () => {
    const v = view("", 0);
    runCommandByKey(v, "b");
    expect(v.state.doc.toString()).toBe("**bold text**");
    const { from, to } = v.state.selection.main;
    expect(v.state.sliceDoc(from, to)).toBe("bold text");
  });

  it("粗体：包裹已有选区且保持选中内容", () => {
    const v = view("hello world", 0, 5);
    runCommandByKey(v, "b");
    expect(v.state.doc.toString()).toBe("**hello** world");
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe("hello");
  });

  it("标题：在当前行行首加标记", () => {
    const v = view("第一行\n第二行\n", 5);
    runCommandByKey(v, "h");
    expect(v.state.doc.toString()).toBe("第一行\n## 第二行\n");
  });

  it("列表与任务：行首标记", () => {
    const v = view("项\n", 0);
    runCommandByKey(v, "ul");
    expect(v.state.doc.toString()).toBe("- 项\n");
    const v2 = view("项\n", 0);
    runCommandByKey(v2, "task");
    expect(v2.state.doc.toString()).toBe("- [ ] 项\n");
  });

  it("公式块：插入 $$ 并把光标放在中间", () => {
    const v = view("", 0);
    runCommandByKey(v, "formula");
    expect(v.state.doc.toString()).toBe("$$\n\n$$\n");
    expect(v.state.selection.main.head).toBe(3);
  });

  it("表格：光标在行中时先换行再插入（不塞进当前行中间）", () => {
    const v = view("前言", 2);
    runCommandByKey(v, "table");
    const text = v.state.doc.toString();
    expect(text.startsWith("前言\n|")).toBe(true);
    expect(text).toContain("| 列一 | 列二 |");
  });

  it("命令进入撤销历史（⌘Z 可回退）", () => {
    const v = view("x", 1);
    runCommandByKey(v, "b");
    expect(v.state.doc.toString()).toBe("x**bold text**");
    undo(v);
    expect(v.state.doc.toString()).toBe("x");
  });

  it("未知 key 不改动文档", () => {
    const v = view("abc", 0);
    const command = commandByKey("nope-not-exist");
    expect(command).toBeUndefined();
    runCommandByKey(v, "nope-not-exist");
    expect(v.state.doc.toString()).toBe("abc");
  });
});
