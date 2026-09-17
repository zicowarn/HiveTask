// @vitest-environment jsdom
/**
 * 样本集冒烟：把 `scripts/make-kb-samples.py` 生成的测试库**整个过一遍注册表**，
 * 逐个断言"该文件被哪个插件接走、能不能渲染出来"。
 *
 * 为什么值得单独测一层：插件单测只证明"插件自己没问题"，证明不了
 * "面板会把文件交给对的插件"——历史上就栽在这里（`kind` 兜底把注册表架空，
 * 所有格式都被当纯文本打开，插件单测却全绿）。
 * 这里用**真文件**（含 OFV 借来的真 DWG/OFD/Shapefile）走同一条解析路径。
 *
 * 样本库不在仓库里（`/tmp/kb-spike`，由脚本生成），所以：**没有样本库时整组跳过**，
 * 不阻塞没生成过样本的环境。生成命令见 `scripts/make-kb-samples.py`。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewContext } from "../src/knowledge/preview/registry";
import { stubResizeObserver } from "./test-support";

const ROOT = process.env.KB_SAMPLES ?? "/tmp/kb-spike";
const hasCorpus = existsSync(join(ROOT, "测试清单.md"));

/** 只验"路由"的格式（重依赖或需要 GPU/网络，渲染细节留给实机）。 */
const ROUTING_ONLY: Record<string, string[]> = {
  "01-文本/中文说明.txt": ["text"],
  "01-文本/遗留GBK.txt": ["text"],
  "01-文本/带BOM的CRLF.txt": ["text"],
  "01-文本/长文.txt": ["text"],
  "01-文本/代码/示例.rs": ["text"],
  "01-文本/代码/示例.json": ["text"],
  "02-文档/Word-中文.docx": ["word"],
  "02-文档/PPT-中文.pptx": ["slides"],
  "02-文档/多表-中文.xlsx": ["sheet"],
  "02-文档/旧版-中文.xls": ["sheet"],
  "02-文档/多表-中文.ods": ["sheet"],
  "02-文档/表格-UTF8.csv": ["sheet"],
  "02-文档/表格-GBK.csv": ["sheet"],
  "02-文档/邮件.eml": ["email"],
  "02-文档/示例.md": ["text"], // Markdown 归编辑器；注册表里认领它的是文本插件（兜底）
  "03-数据/3D/模型.glb": ["model3d"],
  "03-数据/3D/立方体.obj": ["model3d"],
  "03-数据/3D/三角面.stl": ["model3d"],
  "03-数据/3D/点云.ply": ["model3d"],
  "03-数据/3D/不可渲染.fbx": ["model3d"],
  "03-数据/CAD/中文图纸.dxf": ["cad"],
  "03-数据/CAD/蝴蝶.dxf": ["cad"],
  "03-数据/CAD/真实图纸.dwg": ["cad"],
  "03-数据/矢量.geojson": ["gis"],
  "03-数据/地标.kml": ["gis"],
  "03-数据/轨迹.gpx": ["gis"],
  "03-数据/拓扑.topojson": ["gis"],
  "03-数据/图片/色板.png": [], // 图片走面板的 <img> 分支，不进注册表
  "04-媒体/音调.wav": ["audio"],
  "04-媒体/语音.m4a": ["audio"],
  "04-媒体/视频片段.mp4": ["video"],
  "05-边界/PDF-真实样本.pdf": ["pdf"],
  "05-边界/真实OFD.ofd": ["ofd"],
  "05-边界/真实表格.xlsx": ["sheet"],
  "05-边界/样本.geojson": ["gis"],
  "05-边界/样本.kml": ["gis"],
  "05-边界/样本.gpx": ["gis"],
  "05-边界/样本.topojson": ["gis"],
  "05-边界/样本.kmz": ["gis"],
  "05-边界/shapefile/pandr.shp": ["gis"],
  "05-边界/无扩展名PDF": ["pdf"], // 无扩展名 → magic 兜底（magic 通道的正牌用例）
  "05-边界/伪装成文本的PDF.txt": ["text"], // 扩展名撒谎：按"扩展名优先"规则当文本（已知取舍）
  "05-边界/损坏的压缩包.zip": ["archive"],
  "05-边界/随机二进制.bin": [], // 无插件认领 → 面板给"暂不支持"卡片
};

/** 自研解析的格式：真渲染一遍，断言关键结构出现。 */
const RENDER_CASES: { file: string; expect: (container: HTMLElement) => void }[] = [
  {
    file: "02-文档/OFD-公文.ofd",
    expect: (c) => {
      expect(c.querySelectorAll(".kb-ofd-page").length).toBe(2);
      expect(c.textContent).toContain("中文公文测试文件");
      expect(c.querySelector("img")).not.toBeNull(); // 第二页的图像对象
    },
  },
  {
    file: "02-文档/XPS-固定版式.xps",
    expect: (c) => {
      expect(c.querySelectorAll(".kb-xps-page").length).toBe(2);
      expect(c.textContent).toContain("XPS 第一页");
    },
  },
  {
    file: "02-文档/电子书.epub",
    expect: (c) => {
      const chapters = [...c.querySelectorAll(".kb-epub-chapter")].map((el) => el.textContent ?? "");
      expect(chapters.length).toBe(2);
      expect(chapters[0]).toContain("第一章");
      expect(chapters[1]).toContain("第二章"); // spine 顺序
      expect(c.querySelector("script"), "EPUB 里的脚本要被清洗").toBeNull();
    },
  },
  {
    file: "02-文档/思维导图.xmind",
    expect: (c) => {
      expect(c.textContent).toContain("知识库预览");
      expect(c.textContent).toContain("OFD 公文");
    },
  },
  {
    file: "02-文档/流程图.drawio",
    expect: (c) => {
      const boxes = [...c.querySelectorAll(".kb-drawio-box")].map((el) => el.textContent);
      expect(boxes).toContain("开始");
      expect(boxes).toContain("渲染预览"); // 标签里的 <b> 要去掉
    },
  },
  {
    file: "03-数据/CAD/中文图纸.dxf",
    expect: (c) => {
      const svg = c.querySelector("svg");
      expect(svg, "DXF 应画出 SVG").not.toBeNull();
      expect(svg!.textContent, "GBK 码页的中文要解出来").toContain("中文图纸测试");
      expect(svg!.textContent, "\\U+ 转义也要解出来").toContain("房间A");
    },
  },
  {
    file: "03-数据/CAD/蝴蝶.dxf",
    expect: (c) => {
      expect(c.querySelectorAll("svg path").length).toBe(44); // 44 条样条
    },
  },
  {
    file: "02-文档/示例.md",
    expect: () => {
      /* Markdown 走编辑器，这里不渲染 */
    },
  },
  {
    file: "02-文档/多表-中文.xlsx",
    expect: (c) => {
      expect(c.querySelectorAll(".kb-sheet-tab").length, "两张工作表应有 Tab").toBe(2);
      expect(c.textContent).toContain("中文条目");
    },
  },
  {
    file: "02-文档/多表-中文.ods",
    expect: (c) => {
      // ODF 表格：SheetJS 也吃 —— 曾经因为扩展名清单没写 ods，被压缩包插件抢走
      expect(c.querySelectorAll(".kb-sheet-tab").length).toBe(2);
      expect(c.textContent).toContain("中文条目");
    },
  },
  {
    file: "02-文档/旧版-中文.xls",
    expect: (c) => {
      expect(c.querySelectorAll(".kb-sheet-tab").length).toBe(2);
      expect(c.textContent).toContain("中文条目");
    },
  },
  {
    file: "02-文档/表格-GBK.csv",
    expect: (c) => {
      // csv 是纯文本：不能被"表格要求 zip 头"的判定踢出去
      expect(c.querySelector(".kb-sheet") ?? c.querySelector("table")).not.toBeNull();
    },
  },
].filter((case_) => existsSync(join(ROOT, case_.file)));

function contextFor(rel: string, container: HTMLElement): PreviewContext {
  const abs = join(ROOT, rel);
  const name = rel.split("/").pop() ?? rel;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const readBytes = async (): Promise<Uint8Array> => new Uint8Array(readFileSync(abs));
  return {
    root: ROOT,
    rel,
    name,
    ext,
    container,
    readBytes,
    readText: async () => new TextDecoder().decode(await readBytes()),
    readSibling: async (sibling: string) => new Uint8Array(readFileSync(join(ROOT, rel.split("/").slice(0, -1).join("/"), sibling))),
    theme: "light",
  };
}

beforeEach(() => {
  // CAD 的"适应窗口"跟随容器尺寸；jsdom 没有 ResizeObserver（真实引擎都有）
  stubResizeObserver();
  vi.resetModules();
});

describe.skipIf(!hasCorpus)("样本集冒烟（scripts/make-kb-samples.py 生成）", () => {
  it("每个样本都被预期的插件接走（含「扩展名撒谎」与「无插件认领」两类反例）", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const wrong: string[] = [];

    for (const [rel, expected] of Object.entries(ROUTING_ONLY)) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue; // 个别样本依赖本机素材（视频/录像），缺了就跳过
      const name = rel.split("/").pop()!;
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
      const hit = await registry.resolvePreview({ root: ROOT, rel, name, ext }, async () =>
        new Uint8Array(readFileSync(abs)),
      );
      const id = hit?.id ?? null;
      const expectedId = expected.length ? expected[0] : null;
      if (id !== expectedId) wrong.push(`${rel}: 期望 ${expectedId ?? "(无插件)"}，实得 ${id ?? "(无插件)"}`);
    }

    expect(wrong, `路由不符：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("自研解析的格式真渲染出结构", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");

    for (const case_ of RENDER_CASES) {
      const container = document.createElement("div");
      const ctx = contextFor(case_.file, container);
      const resolved = await registry.resolvePreview(
        { root: ROOT, rel: case_.file, name: ctx.name, ext: ctx.ext },
        ctx.readBytes,
      );
      expect(resolved, `${case_.file} 应有插件认领`).not.toBeNull();
      await resolved!.plugin.render(ctx);
      case_.expect(container);
    }
  }, 30_000);

  it("样本清单里的文件确实存在（清单与文件不脱节）", () => {
    const checklist = readFileSync(join(ROOT, "测试清单.md"), "utf8");
    const missing: string[] = [];
    for (const line of checklist.split("\n")) {
      const match = /^\| `([^`]+)` \|/.exec(line);
      if (!match) continue;
      const rel = match[1].replace(/\/$/, "");
      if (!existsSync(join(ROOT, rel))) missing.push(rel);
    }
    expect(missing, `清单里列了但不存在的文件：\n${missing.join("\n")}`).toEqual([]);
  });

  it("样本不是空壳（真实内容由上面的渲染断言保证，这里只挡 0 字节/截断）", () => {
    for (const case_ of RENDER_CASES) {
      const size = statSync(join(ROOT, case_.file)).size;
      expect(size, `${case_.file} 是空文件`).toBeGreaterThan(40);
    }
  });
});
