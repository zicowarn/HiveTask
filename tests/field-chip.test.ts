/**
 * 卡片 chip 配色的契约（平台实测量，2026-09-16 取证）：八色选项 → Primer 语义三元组；
 * 数字/文本/日期字段没有选项色 → neutral 组；本地取色器的自选色就近归一。
 */
import { describe, expect, it } from "vitest";
import { chipColors, NEUTRAL_CHIP } from "../src/panels/field-chip";

describe("字段 chip 配色", () => {
  it("八色调色板逐色对齐平台语义三元组", () => {
    expect(chipColors("#59636e")).toMatchObject({ semantic: "neutral", bg: "#818b981f", fg: "#59636e" });
    expect(chipColors("#0969da")).toMatchObject({ semantic: "accent", bg: "#ddf4ff", border: "#54aeff66" });
    expect(chipColors("#1a7f37")).toMatchObject({ semantic: "success", bg: "#dafbe1" });
    expect(chipColors("#9a6700")).toMatchObject({ semantic: "attention", bg: "#fff8c5" });
    expect(chipColors("#bc4c00")).toMatchObject({ semantic: "severe", bg: "#fff1e5" });
    expect(chipColors("#d1242f")).toMatchObject({ semantic: "danger", bg: "#ffebe9", border: "#ff818266" });
    expect(chipColors("#bf3989")).toMatchObject({ semantic: "sponsors", bg: "#ffeff7" });
    expect(chipColors("#8250df")).toMatchObject({ semantic: "done", bg: "#fbefff" });
  });

  it("大小写与无 # 前缀等价；数字字段无色调 → neutral", () => {
    expect(chipColors("8250DF").semantic).toBe("done");
    expect(chipColors(null)).toEqual(NEUTRAL_CHIP);
    expect(chipColors("")).toEqual(NEUTRAL_CHIP);
  });

  it("自选色归一到最近的语义档（平台的选项本就只有八色）", () => {
    expect(chipColors("#0a6adc").semantic).toBe("accent");
    expect(chipColors("#d0242d").semantic).toBe("danger");
    expect(chipColors("#zzzzzz")).toEqual(NEUTRAL_CHIP); // 无法解析 → neutral
  });
});
