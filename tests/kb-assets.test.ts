/**
 * 插图落点与命名（纯函数部分）。
 * 写盘路径另有 Rust 单测（kb_write_bytes：建父目录、覆盖、越界拒绝），
 * 端到端的"粘贴 → 落盘 → 插入引用"需要真机（浏览器预览没有 Rust 侧写入）。
 */
import { describe, expect, it } from "vitest";
import {
  assetLink,
  assetRelPath,
  extensionFor,
  imageFilesFrom,
  pastedFileName,
} from "../src/knowledge/editor/assets";

describe("插图落点", () => {
  it("存到文档同级的 assets/（引用不依赖文档深度）", () => {
    expect(assetRelPath("note.md", "a.png")).toBe("assets/a.png");
    expect(assetRelPath("docs/note.md", "a.png")).toBe("docs/assets/a.png");
    expect(assetRelPath("docs/sub/note.md", "a.png")).toBe("docs/sub/assets/a.png");
  });

  it("引用是相对文档的 assets/ 路径", () => {
    expect(assetLink("pasted-1.png")).toBe("![pasted-1.png](assets/pasted-1.png)");
    expect(assetLink("a.png", "示意图")).toBe("![示意图](assets/a.png)");
  });

  it("文件名带时间戳，冲突时加序号", () => {
    const at = new Date(2026, 8, 17, 10, 45, 3);
    expect(pastedFileName(at, 0, "png")).toBe("pasted-20260917-104503.png");
    expect(pastedFileName(at, 2, "jpg")).toBe("pasted-20260917-104503-2.jpg");
  });

  it("扩展名优先按 MIME 判定（剪贴板的文件名常不可靠）", () => {
    expect(extensionFor(new File([], "image.png", { type: "image/jpeg" }))).toBe("jpg");
    expect(extensionFor(new File([], "shot.webp", { type: "" }))).toBe("webp");
    expect(extensionFor(new File([], "", { type: "image/png" }))).toBe("png");
  });
});

describe("从剪贴板/拖放里挑图片", () => {
  it("只挑 image/*，忽略其它文件", () => {
    const png = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    const dt = { files: [png, txt] } as unknown as DataTransfer;
    expect(imageFilesFrom(dt).map((f) => f.name)).toEqual(["a.png"]);
  });

  it("空/无 files 时返回空数组（不抛）", () => {
    expect(imageFilesFrom(null)).toEqual([]);
    expect(imageFilesFrom({ files: [] } as unknown as DataTransfer)).toEqual([]);
  });
});
