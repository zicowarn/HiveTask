// @vitest-environment jsdom
/**
 * 3D 解码器**逐个真解析** —— 每个扩展名都要有一份真实样本、并真的过一遍 three 的 Loader。
 *
 * 为什么单独有这一层：全样本审计（kb-preview-corpus）在 jsdom 里跑到 WebGL 创建就退了，
 * 解析路径一次都不会执行；类型检查更只能证明"签名对得上"（`.shp` 那次
 * `parseShp is not a function` 就是这么漏过去的）。这里绕开 WebGL/DOM 渲染，
 * 直接调 `parseModel()` —— 判据是"真读出了三角面"，不是"没抛错"。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_EXTENSIONS, parseModel } from "../src/knowledge/preview/plugins/model3d";

const ROOT = process.env.KB_SAMPLES ?? "/tmp/kb-spike";
const DIR = join(ROOT, "03-数据", "3D");

/** 扩展名 → 样本文件名（每个支持的扩展名都要有样本，漏了就红）。 */
const FILES: Record<string, string> = {
  glb: "模型.glb",
  obj: "立方体.obj",
  stl: "三角面.stl",
  ply: "点云.ply",
  fbx: "三角面.fbx",
  dae: "模型.dae",
  "3ds": "模型.3ds",
  "3mf": "模型.3mf",
  amf: "模型.amf",
  wrl: "立方体.wrl",
  // VRML 的两个扩展名共用一个 loader：样本是同一份 .wrl
  vrml: "立方体.wrl",
  gltf: "模型.gltf",
  usda: "模型.usda",
  // .usd 既可能是文本也可能是二进制 crate：样本给文本，与 .usda 同一条通道
  usd: "模型.usda",
  usdz: "模型.usdz",
};

/** 有样本、但环境受限的扩展名（原因写在注释里）：这些只断言"不抛错"。 */
const ENV_LIMITED: Record<string, string> = {
  // 二进制 USD（crate）没法手搓：文本通道由 .usda/.usd 覆盖
  usdc: "二进制 USD 无手搓样本（.usda 覆盖同一 loader 的文本通道）",
};

/** 附件读取：样本与模型同目录，"外部 .bin 附件"这条路就在这条线上。 */
async function readSibling(rel: string): Promise<Uint8Array> {
  return new Uint8Array(readFileSync(join(ROOT, rel)));
}

const hasCorpus = existsSync(DIR);

/** 数出对象树里的三角面数（与插件信息行同一口径）。 */
function triangles(root: import("three").Object3D): number {
  let count = 0;
  root.traverse((child) => {
    const mesh = child as import("three").Mesh;
    if (mesh.geometry?.index) count += mesh.geometry.index.count / 3;
    else if (mesh.geometry?.attributes?.position) count += mesh.geometry.attributes.position.count / 3;
  });
  return count;
}

describe.skipIf(!hasCorpus)("3D 解码器（每个扩展名一份真样本）", () => {
  for (const [ext, file] of Object.entries(FILES)) {
    it(`${ext} ← ${file} 能解析出三角面`, async () => {
      const path = join(DIR, file);
      expect(existsSync(path), `缺样本 ${file}（scripts/make-kb-samples.py 生成）`).toBe(true);
      const bytes = new Uint8Array(readFileSync(path));
      const mesh = await parseModel({ ext, rel: `03-数据/3D/${file}`, readSibling }, bytes);
      expect(triangles(mesh), `${file} 没读出三角面`).toBeGreaterThan(0);
    }, 60000);
  }

  it("每个已注册的 3D 扩展名都有样本覆盖（新增格式必须同时补样本）", () => {
    const missing = MODEL_EXTENSIONS.filter((ext) => !(ext in FILES) && !(ext in ENV_LIMITED));
    expect(missing, `没有样本的扩展名：${missing.join(", ")}`).toEqual([]);
  });

  it("未知扩展名给出明确错误，而不是拿别的 loader 硬解", async () => {
    await expect(parseModel({ ext: "step", rel: "x.step" }, new Uint8Array())).rejects.toThrow(/没有可用的 3D 解码器/);
  });
});
