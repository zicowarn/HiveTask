// @vitest-environment jsdom
/**
 * 表格网格编辑器（SoloMD 移植）：纯函数模型 + 对话框行为。
 *
 * 移植判据取 SoloMD 的 markdown-table.test.ts 同款用例口径：parse/serialize 往返、
 * 行列结构操作、findTableSpan 的边界（分隔行缺失 = 不是表格）。
 */
import { describe, expect, it } from "vitest";
import {
  findTableSpan,
  parseTable,
  serializeTable,
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
  moveRow,
  moveColumn,
  setAlign,
  setCell,
  emptyTable,
} from "../src/knowledge/editor/markdown-table";

const SRC = ["| 名字 | 数量 |", "| --- | ---: |", "| 苹果 | 3 |", "| 香蕉 | 12 |"].join("\n");

describe("表格解析与序列化", () => {
  it("parse → serialize 往返保内容（列对齐是序列化器的事）", () => {
    const model = parseTable(SRC);
    expect(model).not.toBeNull();
    expect(model!.header).toEqual(["名字", "数量"]);
    expect(model!.aligns).toEqual([null, "right"]);
    expect(model!.rows).toEqual([["苹果", "3"], ["香蕉", "12"]]);
    const back = serializeTable(model!);
    const reparsed = parseTable(back)!;
    expect(reparsed.header).toEqual(model!.header);
    expect(reparsed.rows).toEqual(model!.rows);
  });

  it("单元格里的 \\| 是字面竖线，不切列", () => {
    const model = parseTable("| a | b |", );
    void model;
    const m = parseTable(["| a | b |", "| --- | --- |", '| `\\|` | 竖线 |'].join("\n"))!;
    expect(m.rows[0][0]).toBe("`|`");
    expect(m.rows[0].length).toBe(2);
  });

  it("参差的行补齐而不是拒绝（让编辑器修表格）", () => {
    const m = parseTable(["| a | b | c |", "| --- | --- | --- |", "| 1 |"].join("\n"))!;
    expect(m.rows[0]).toEqual(["1", "", ""]);
  });

  it("findTableSpan：光标在表内任一行都找到全表；分隔行缺失 = 不是表格", () => {
    const doc = "前言\n| a | b |\n| --- | --- |\n| 1 | 2 |\n后记".split("\n");
    expect(findTableSpan(doc, 1)).toEqual({ startLine: 1, endLine: 3 });
    expect(findTableSpan(doc, 3)).toEqual({ startLine: 1, endLine: 3 });
    expect(findTableSpan(doc, 0)).toBeNull();
    const fake = ["| a | b |", "| 1 | 2 |"].join("\n").split("\n"); // 无分隔行
    expect(findTableSpan(fake, 0)).toBeNull();
  });

  it("CJK 按双宽对齐：序列化后中英文列都对齐", () => {
    const out = serializeTable(parseTable("| 名字 | name |\n| --- | --- |\n| 苹果 | apple |")!);
    const lines = out.split("\n");
    expect(lines[0].indexOf("|")).toBe(lines[1].indexOf("|"));
    // "名字"(4) vs "苹果"(4)、"name"(4) —— 竖线位置逐行一致
    expect(new Set(lines.map((l) => l.split("|").length)).size).toBe(1);
  });
});

describe("结构操作（全部纯函数）", () => {
  it("插入/删除行", () => {
    let m = parseTable(SRC)!;
    m = insertRow(m, 1);
    expect(m.rows.length).toBe(3);
    expect(m.rows[1]).toEqual(["", ""]);
    m = deleteRow(m, 1);
    expect(m.rows.length).toBe(2);
  });

  it("插入/删除列（删到最后一列时拒绝）", () => {
    let m = parseTable(SRC)!;
    m = insertColumn(m, 1);
    expect(m.header).toEqual(["名字", "", "数量"]);
    m = deleteColumn(m, 0);
    expect(m.header).toEqual(["", "数量"]);
    expect(deleteColumn(m, 0).header.length).toBe(1);
    expect(deleteColumn(m, 0).header.length).toBe(1, "最后一列删不掉（删表是另一回事）");
  });

  it("移动行/列", () => {
    let m = parseTable(SRC)!;
    m = moveRow(m, 0, 1);
    expect(m.rows[0][0]).toBe("香蕉");
    m = moveColumn(m, 1, 0);
    expect(m.header[0]).toBe("数量");
  });

  it("setCell 转义竖线、吞换行；setAlign 生效", () => {
    let m = parseTable(SRC)!;
    m = setCell(m, 0, 0, "a|b\nc");
    // setCell 存原始值；转义发生在序列化（escapeCell）
    expect(m.rows[0][0]).toBe("a|b c");
    expect(serializeTable(m)).toContain("a\\|b c");
    m = setAlign(m, 1, "center");
    expect(m.aligns[1]).toBe("center");
    expect(serializeTable(m).split("\n")[1]).toContain(":--:");
  });

  it("emptyTable：插入空表的起点", () => {
    const m = emptyTable();
    expect(m.header.length).toBe(3);
    expect(m.rows.length).toBe(2);
  });
});
