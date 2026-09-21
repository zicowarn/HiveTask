/**
 * wikilink 前端工具的消解口径测试——与 Rust 侧 kb_graph.rs 的
 * resolves_by_path_then_unique_stem 同一组用例，锚定两侧语义一致。
 */
import { describe, expect, it } from "vitest";
import { buildNoteIndex, fileStemOf, resolveWikilink, wikilinkTargetOf } from "../src/knowledge/wikilink";

describe("wikilinkTargetOf", () => {
  it("剥掉别名与小节", () => {
    expect(wikilinkTargetOf("Alpha")).toBe("Alpha");
    expect(wikilinkTargetOf("Beta|别名")).toBe("Beta");
    expect(wikilinkTargetOf("Gamma#小节")).toBe("Gamma");
    expect(wikilinkTargetOf("dir/Delta | x # y")).toBe("dir/Delta");
  });

  it("同文件锚点为空", () => {
    expect(wikilinkTargetOf("#小节")).toBe("");
  });
});

describe("fileStemOf", () => {
  it("取末段去扩展名（隐藏文件不误剥）", () => {
    expect(fileStemOf("a.md")).toBe("a");
    expect(fileStemOf("dir/sub/c.markdown")).toBe("c");
    expect(fileStemOf(".hidden")).toBe(".hidden");
  });
});

describe("resolveWikilink", () => {
  const index = buildNoteIndex(["a.md", "dir/b.md", "dir/sub/c.md", "one/amb.md", "two/amb.md"]);

  it("库根相对（原样与补 .md）", () => {
    expect(resolveWikilink("dir/b.md", "a.md", index)).toBe("dir/b.md");
    expect(resolveWikilink("dir/b", "a.md", index)).toBe("dir/b.md");
  });

  it("源文件目录相对（markdown 常规语义）", () => {
    expect(resolveWikilink("./c.md", "dir/b.md", index)).toBe("dir/sub/c.md");
    expect(resolveWikilink("../b.md", "dir/sub/c.md", index)).toBe("dir/b.md");
  });

  it("文件名唯一兜底（wikilink 语义）", () => {
    expect(resolveWikilink("c", "a.md", index)).toBe("dir/sub/c.md");
  });

  it("歧义、未命中、越出根、空目标", () => {
    expect(resolveWikilink("amb", "a.md", index)).toBeNull();
    expect(resolveWikilink("ghost", "a.md", index)).toBeNull();
    expect(resolveWikilink("../../x.md", "dir/sub/c.md", index)).toBeNull();
    expect(resolveWikilink("#anchor", "a.md", index)).toBeNull();
    expect(resolveWikilink("http://e.com/a.md", "a.md", index)).toBeNull();
  });
});
