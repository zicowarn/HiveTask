// @vitest-environment jsdom
/**
 * **全样本审计**：把样本库里每个文件都过一遍「注册表判定 + 真渲染」，任何**非预期**的
 * 渲染失败都算红灯。
 *
 * 为什么必须有这一层：单元测试只证明"我改的那条路没问题"。`.shp` 那次真 bug
 * （`shpjs.parseShp is not a function` —— 默认导出上没有这三个方法，而 `@types/shpjs`
 * 把它们声明在命名空间上，TypeScript 放行、运行时才炸）就是**只有一个"逐个文件跑起来"的
 * 审计**才抓得到的，按功能的单测全绿。这个文件就是那次审计的常驻版本。
 *
 * 环境限制导致的失败写在 ALLOWED 里（jsdom 没有 WebGL / 没有 HTTP 服务 / 没有 canvas），
 * 它们的实机验证在交付清单里；**其余任何失败都必须当真修的 bug**。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stubResizeObserver } from "./test-support";

const ROOT = process.env.KB_SAMPLES ?? "/tmp/kb-spike";
const MARKER = join(ROOT, "测试清单.md");
const hasCorpus = (() => {
  try {
    return statSync(MARKER).isFile();
  } catch {
    return false;
  }
})();

/** 已知的"环境限制"失败：原因写在注释里，实机验证在交付清单。 */
const ALLOWED: { match: RegExp; why: string }[] = [
  // 注意匹配顺序：报错文本是先 ENOENT 再给路径，别把正则写成"路径在前"
  { match: /\[cad\].*ENOENT.*libredwg-web\.wasm/, why: "jsdom 没有 HTTP 服务（实机由 vite/Tauri 提供 /vendor）" },
  { match: /\[archive\].*Corrupted zip/, why: "样本就是故意损坏的压缩包：出错是设计行为" },
  { match: /\[pdf\].*Invalid PDF structure/, why: "样本是只用 magic 认领的假 PDF：解析失败是设计行为" },
];
// 曾经还有两条，已随功能补齐而删掉（留着会掩盖回归）：
// - `[model3d] ... WebGL context`：3D 现在捕获 WebGL 创建失败 → 诚实卡片（照 OFV）
// - `[pdf] ... IntersectionObserver`：PDF 现在探测该 API，没有就退化成"全部立即渲染"（照 OFV）

/** 允许"无插件认领"的样本：面板另有分支处理（图片走 <img>、无扩展名文本走文本回退）。 */
const ALLOWED_NO_PLUGIN = [
  /^01-文本\/无扩展名$/,
  /\.png$/,
  /^05-边界\/随机二进制\.bin$/,
  // Shapefile 的二进制索引伴生文件（.shx/.sbn/.sbx）：点开它们是误操作，
  // 走面板的"暂不支持"卡片（带系统预览图兜底）即可，不需要专门渲染器
  /^05-边界\/shapefile\/pandr\.(shx|sbn|sbx)$/,
  // 我们在 docs/kb-preview-formats.md §5.5 里**已登记为不做**的 CAD 交换格式
  // （需要专用内核）：走通用"暂不支持 + 默认应用打开"卡片就是预期行为
  /^03-数据\/CAD\/15bias\.(GDS|oas)$/i,
  // glTF 的外部 .bin 缓冲：是模型的附件，不是给人单开的文件（点开走"暂不支持"卡片即可）
  /^03-数据\/3D\/模型\.bin$/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full));
  }
  return out;
}

describe.skipIf(!hasCorpus)("全样本审计（注册表判定 + 真渲染）", () => {
  it("每个样本要么渲染成功、要么落在**已记录**的环境限制/设计行为里", async () => {
    stubResizeObserver();
    vi.resetModules();
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");

    const files = walk(ROOT).filter((rel) => !rel.endsWith("测试清单.md"));
    expect(files.length, "样本库应有文件").toBeGreaterThan(30);

    const problems: string[] = [];
    const allowedHits: string[] = [];

    for (const rel of files.sort()) {
      const name = rel.split("/").pop() ?? rel;
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
      const readBytes = async (): Promise<Uint8Array> => new Uint8Array(readFileSync(join(ROOT, rel)));

      let resolved: Awaited<ReturnType<typeof registry.resolvePreview>> = null;
      try {
        resolved = await registry.resolvePreview({ root: ROOT, rel, name, ext }, readBytes);
      } catch (error) {
        problems.push(`判定抛错 ${rel} :: ${String(error)}`);
        continue;
      }
      if (!resolved) {
        if (!ALLOWED_NO_PLUGIN.some((pattern) => pattern.test(rel))) {
          problems.push(`无插件认领（且不在豁免名单）${rel}`);
        }
        continue;
      }

      const container = document.createElement("div");
      try {
        await resolved.plugin.render({
          root: ROOT,
          rel,
          name,
          ext,
          theme: "light",
          container,
          readBytes,
          readText: async () => readFileSync(join(ROOT, rel), "utf8"),
          readSibling: async (sibling: string) => new Uint8Array(readFileSync(join(ROOT, sibling))),
        });
      } catch (error) {
        const line = `渲染失败 [${resolved.id}] ${rel} :: ${String(error).slice(0, 160)}`;
        if (ALLOWED.some((item) => item.match.test(line))) allowedHits.push(`${line}  ← ${ALLOWED.find((i) => i.match.test(line))!.why}`);
        else problems.push(line);
      }
    }

    if (allowedHits.length) {
      console.log(`\n环境限制内的失败 ${allowedHits.length} 条（实机验证）：\n${allowedHits.join("\n")}`);
    }
    expect(problems, `非预期的失败：\n${problems.join("\n")}`).toEqual([]);
  }, 180000);
});
