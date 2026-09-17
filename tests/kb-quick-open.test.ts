/**
 * ⌘P 的模糊匹配与排序（纯函数）。
 *
 * 排序口径照 VS Code：文件名命中优先于路径命中、连续/词首命中优先、短路径优先；
 * 空查询给"最近打开"（⌘P 最常用的用法是回到刚才那个文件，不是找）。
 */
import { describe, expect, it } from "vitest";
import { fuzzyScore, rankFiles } from "../src/knowledge/quick-open";

describe("模糊匹配", () => {
  it("子序列匹配，顺序不对则不匹配", () => {
    expect(fuzzyScore("note.md", "nt")).not.toBeNull();
    expect(fuzzyScore("note.md", "tn")).toBeNull();
    expect(fuzzyScore("note.md", "zzz")).toBeNull();
  });

  it("连续命中与词首命中得分更高", () => {
    const contiguous = fuzzyScore("note.md", "note")!;
    const scattered = fuzzyScore("n-o-t-e.md", "note")!;
    expect(contiguous).toBeGreaterThan(scattered);
    const wordStart = fuzzyScore("my-note.md", "note")!;
    const middle = fuzzyScore("mynote.md", "note")!;
    expect(wordStart).toBeGreaterThan(middle);
  });

  it("大小写不敏感；空查询得 0", () => {
    expect(fuzzyScore("Note.MD", "note")).toBe(fuzzyScore("note.md", "note"));
    expect(fuzzyScore("note.md", "")).toBe(0);
  });
});

describe("排序", () => {
  const files = ["docs/note.md", "note.md", "src/knowledge/notes/deep-note.md", "readme.md", "src/main.ts"];

  it("文件名命中排在路径命中之前", () => {
    const ranked = rankFiles(files, "note");
    expect(ranked[0].rel, "note.md 应排第一").toBe("note.md");
    expect(ranked.map((item) => item.rel)).not.toContain("src/main.ts");
  });

  it("只按路径命中的也能找到（查询里带目录）", () => {
    const ranked = rankFiles(files, "knowledge");
    expect(ranked.map((item) => item.rel)).toEqual(["src/knowledge/notes/deep-note.md"]);
  });

  it("空查询 = 最近打开优先，其余按原顺序补齐", () => {
    const ranked = rankFiles(files, "", ["readme.md", "src/main.ts"]);
    expect(ranked.slice(0, 2).map((item) => item.rel)).toEqual(["readme.md", "src/main.ts"]);
    expect(ranked.length).toBe(files.length);
  });

  it("最近打开在**有查询**时只加权不越级", () => {
    // readme.md 最近打开过，但它并不匹配 "note"
    const ranked = rankFiles(files, "note", ["readme.md"]);
    expect(ranked.every((item) => item.rel.includes("note"))).toBe(true);
  });

  it("返回文件名与目录（展示成两行）且带条数上限", () => {
    const ranked = rankFiles(files, "e", [], 2);
    expect(ranked.length).toBe(2);
    expect(ranked[0].name).toBeTruthy();
    expect(ranked.every((item) => !item.name.includes("/"))).toBe(true);
  });
});
