/** 字数统计口径（状态栏显示的唯一来源）。 */
import { describe, expect, it } from "vitest";
import { countText } from "../src/knowledge/editor/stats";

describe("文档统计", () => {
  it("汉字 + 全角标点：非空白字符逐个计入", () => {
    expect(countText("知识库，工作台。").chars).toBe(8);
  });

  it("空白（空格/换行/制表）不计入", () => {
    expect(countText("a b\nc\td").chars).toBe(4);
  });

  it("拉丁词：连字符/撇号算一个词", () => {
    expect(countText("hello world").words).toBe(2);
    expect(countText("don't stop").words).toBe(2);
    expect(countText("well-known thing").words).toBe(2);
  });

  it("中英混排：字数含英文，词数只数拉丁词", () => {
    const stats = countText("用 HiveTask 管理 Issue。");
    // 非空白字符：用(1) HiveTask(8) 管理(2) Issue(5) 。(1) = 17
    expect(stats.chars).toBe(17);
    expect(stats.words).toBe(2); // HiveTask、Issue（汉字不计入"词"）
  });

  it("纯中文文档：词数为 0（状态栏据此隐藏词格）", () => {
    expect(countText("只有中文，没有英文单词。").words).toBe(0);
  });

  it("空文档", () => {
    expect(countText("")).toEqual({ chars: 0, words: 0 });
  });

  it("emoji 计为字符（按码点而非 UTF-16 单元）", () => {
    expect(countText("👍").chars).toBe(1);
  });
});

// 文件图标：按类别给 Octicon（不引第三方图标字体）
describe("文件图标分类", async () => {
  const { iconForEntry } = await import("../src/knowledge/file-icon");
  const icon = (name: string, kind = "file") => iconForEntry({ name, kind }, false);

  it("按类别区分：Markdown / 代码 / 媒体 / 压缩 / 二进制 / 数据", () => {
    expect(icon("README.md")).toBe("o.markdown");
    expect(icon("main.rs")).toBe("o.file-code");
    expect(icon("shot.PNG")).toBe("o.file-media"); // 大小写不敏感
    expect(icon("backup.tar.gz")).toBe("o.file-zip");
    expect(icon("a.bin")).toBe("o.file-binary");
    expect(icon("data.csv")).toBe("o.layout-table");
  });

  it("未知扩展名与无扩展名回落到通用文件图标", () => {
    expect(icon("LICENSE")).toBe("o.file");
    expect(icon("weird.zzz")).toBe("o.file");
    expect(icon(".gitignore")).toBe("o.file", "前导点不算扩展名");
  });

  it("目录按开合切换，符号链接单列", () => {
    expect(iconForEntry({ name: "docs", kind: "dir" }, false)).toBe("o.file-directory-fill");
    expect(iconForEntry({ name: "docs", kind: "dir" }, true)).toBe("o.file-directory-open-fill");
    expect(iconForEntry({ name: "link", kind: "symlink" }, false)).toBe("o.file-symlink-file");
  });
});
