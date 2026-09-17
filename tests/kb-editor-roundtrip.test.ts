/**
 * T0 硬门槛 ⑨：md 往返**零失真**。
 *
 * 口径：编辑器缓冲就是磁盘上的 Markdown 源文本，不经过任何中间模型。
 * 这条测试盯住两个容易出事的点：
 *  1. CM6 的 Document 取出时必须与输入**完全一致**（不做列表符/表格对齐/属性顺序归一化）；
 *  2. CM6 内部按 `\n` 分行（`lineSeparator` 默认值），CRLF 文件读进来内部是 LF——
 *     这不是失真，因为**写回时由 Rust 按原 `eol` 还原**（该路径已有 Rust 单测
 *     `keeps_utf8_bom_and_crlf` / `decodes_gbk_and_round_trips_it` 守着字节相等）。
 *     这里把这条分工固定下来，防以后有人"顺手"在 JS 侧做换行转换。
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

const SAMPLE = `# 标题

一段中文正文，含 **粗体**、*斜体*、\`行内代码\` 与 [链接](https://example.com)。

- 列表项一
- 列表项二
  - 嵌套项

| 列 | 值 |
|----|----|
| a  | 1  |

> 引用行

   缩进式代码块（4 空格）
`;

function roundTrip(text: string): string {
  const state = EditorState.create({ doc: text, extensions: [markdown()] });
  return state.doc.toString();
}

describe("Markdown 编辑缓冲往返", () => {
  it("LF 源文本原样取回（零归一化）", () => {
    expect(roundTrip(SAMPLE)).toBe(SAMPLE);
  });

  it("不归一化列表符、表格对齐与行尾空格", () => {
    const tricky = "- 项\n* 星号项\n+ 加号项\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\ntrailing   \n";
    expect(roundTrip(tricky)).toBe(tricky);
  });

  it("CRLF 源文本在编辑器内统一为 LF（写回由 Rust 按原 eol 还原）", () => {
    const crlf = "第一行\r\n第二行\r\n";
    const inEditor = roundTrip(crlf);
    expect(inEditor).toBe("第一行\n第二行\n");
    expect(inEditor.includes("\r")).toBe(false);
  });

  it("中文与全角标点不被改写", () => {
    const cjk = "中文，全角；标点！“引号”…… —— 破折号\n";
    expect(roundTrip(cjk)).toBe(cjk);
  });
});
