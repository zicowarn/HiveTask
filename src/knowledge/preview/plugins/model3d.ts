/**
 * 3D 模型预览 —— three.js 渲染，**全离线**。
 *
 * 支持的格式与解码器（逐条对照 OFV `packages/core/src/plugins/model3d.ts`）：
 *
 * | 格式 | 解码器 | OFV 有 |
 * |---|---|---|
 * | gltf / glb | GLTFLoader | ✓ |
 * | obj | OBJLoader | ✓ |
 * | fbx | FBXLoader | ✓ |
 * | dae | ColladaLoader | ✓ |
 * | stl | STLLoader | ✓ |
 * | ply | PLYLoader | ✓ |
 * | 3ds | TDSLoader | ✓ |
 * | 3mf | ThreeMFLoader | ✓ |
 * | usd/usda/usdc/usdz | USDLoader | ✓ |
 * | vrml / wrl | VRMLLoader | ✓ |
 * | amf | AMFLoader | ✗（我们补的，three 自带） |
 *
 * 这些 Loader **全部在 `three/examples/jsm/loaders/` 里**（three 已是本仓库依赖），
 * 所以 FBX 之类不需要另找"专用解码器"。
 *
 * 关键决策与代价（照 OFV 的形态，实现重写）：
 * - `three` 按需 `import()`：只有真打开模型文件才会拉这份 chunk；
 * - 贴图 / .bin 附件从**知识库内同目录**读（`ctx.readSibling`），预先转成 data URL，
 *   再交给 `LoadingManager.setURLModifier` 映射（three 的 FileLoader 只走 XHR，不能回调异步）；
 * - 灯光用固定两灯 + 环境光，不引 HDR 资源（那要从网上下）；
 * - WebGL 创建失败**不抛**，退化成诚实卡片（OFV 的 `try/catch → renderModelFallback`）。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";

export const MODEL_EXTENSIONS = [
  "gltf",
  "glb",
  "obj",
  "stl",
  "ply",
  "vrml",
  "wrl",
  "fbx",
  "dae",
  "3ds",
  "usd",
  "usda",
  "usdc",
  "usdz",
  "3mf",
  "amf",
];

// ⚠️ 之前把 FBX/DAE/3DS/USDZ/3MF/VRML/AMF 标为"需要专用解码器，本期不做"——这是错的：
// OFV 用的是 **three.js 自带的 Loader**（FBXLoader/ColladaLoader/TDSLoader/USDLoader/
// ThreeMFLoader/VRMLLoader/AMFLoader），而 three 已经是我们的依赖，这些 Loader 就在
// node_modules/three/examples/jsm/loaders/ 里。我们"没有解码器"的说法不成立。

const GLB_MAGIC = "glTF";

/**
 * WebGL 不可用时的诚实卡片。
 *
 * 形态照 OFV `renderModelFallback`（粗体标题 + 说明行）；**桌面适配**（③）：OFV 在网页里
 * 放一个「下载文件」链接，桌面版的对应物是头部已有的「默认应用打开」，所以这里换成
 * **系统预览图**（macOS Quick Look 能渲染 3D）——比一行文字有用，且标明来源不误导。
 */
async function renderFallback(ctx: PreviewContext, wrap: HTMLElement, message: string): Promise<PreviewInstance> {
  const panel = document.createElement("div");
  panel.className = "kb-model3d-fallback";
  const detail = document.createElement("p");
  detail.className = "kb-note";
  detail.textContent = `${message}（${ctx.name}）`;
  panel.appendChild(Object.assign(document.createElement("strong"), { textContent: "3D 预览不可用" }));
  panel.appendChild(detail);
  wrap.appendChild(panel);

  const bytes = await ctx.systemThumbnail?.();
  if (!bytes) {
    ctx.onInfo?.("无 WebGL（当前设备不支持）");
    return {};
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const img = document.createElement("img");
  img.className = "kb-model3d-poster";
  img.alt = ctx.name;
  img.src = url;
  panel.insertBefore(img, detail);
  detail.textContent = `${message} —— 上图为系统生成的预览图`;
  ctx.onInfo?.("无 WebGL · 显示系统预览图");
  return { destroy: () => URL.revokeObjectURL(url) };
}

/** 解析模型所需的最小文件信息（与 `PreviewContext` 的交集，便于单测直接调用）。 */
export interface ModelSource {
  ext: string;
  /** 相对知识库根的路径 —— 用于把模型里引用的相对 uri 解析成同目录文件。 */
  rel: string;
  /** 读同目录附件（贴图 / .bin）；缺失时退化为"不带贴图渲染"。 */
  readSibling?: (rel: string) => Promise<Uint8Array>;
}

/**
 * 打开一份 3D 数据：按扩展名选 three.js 自带 Loader，返回对象树。
 *
 * 与渲染**分离**（不碰 WebGL / DOM），所以 jsdom 里也能真跑一遍解析 ——
 * "loader 接通了没有"这件事必须有测试证据，不能只看类型检查通过。
 */
export async function parseModel(source: ModelSource, bytes: Uint8Array): Promise<import("three").Object3D> {
  const THREE = await import("three");
  const dir = source.rel.includes("/") ? source.rel.slice(0, source.rel.lastIndexOf("/") + 1) : "";
  // 模型里引用的相对 uri（贴图、.bin）→ 知识库同目录文件 → data URL（离线关键点）。
  // three 的 FileLoader 只会走 XHR/fetch、不能异步回调 —— 所以策略是**先预读附件成
  // data URL，再解析模型**；这里只做一次查表映射。
  const preloaded = new Map<string, string>();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    const rel = decodeURIComponent(url.startsWith("kb://") ? url.slice(5) : `${dir}${url}`);
    return preloaded.get(rel) ?? url;
  });

  /** 预读 glTF 引用到的外部资源（贴图/.bin），全部落成本地 data URL。 */
  async function preloadGltf(root: unknown): Promise<void> {
    const jobs: Promise<void>[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (key === "uri" && typeof value === "string" && !value.startsWith("data:")) {
          const rel = decodeURIComponent(value.startsWith("kb://") ? value.slice(5) : `${dir}${value}`);
          jobs.push(
            (async () => {
              if (!source.readSibling) return;
              try {
                const data = await source.readSibling(rel);
                preloaded.set(rel, await blobToDataUrl(new Blob([data])));
              } catch {
                /* 缺失的附件不阻断主体渲染 */
              }
            })(),
          );
        } else if (typeof value === "object") {
          walk(value);
        }
      }
    };
    walk(root);
    await Promise.all(jobs);
  }

  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const material = () => new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.1, roughness: 0.7 });
  switch (source.ext) {
    case "gltf":
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const isBinary = bytes.byteLength > 4 && String.fromCharCode(...bytes.subarray(0, 4)) === GLB_MAGIC;
      if (!isBinary) {
        try { await preloadGltf(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* 坏 JSON 交给 loader */ }
      }
      const gltf = await new GLTFLoader(manager).parseAsync(buffer, "");
      return gltf.scene;
    }
    case "obj":
      return new (await import("three/examples/jsm/loaders/OBJLoader.js")).OBJLoader(manager).parse(
        new TextDecoder().decode(bytes),
      );
    case "stl": {
      const geometry = new (await import("three/examples/jsm/loaders/STLLoader.js")).STLLoader().parse(buffer);
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, material());
    }
    case "ply": {
      const geometry = new (await import("three/examples/jsm/loaders/PLYLoader.js")).PLYLoader().parse(buffer);
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, material());
    }
    case "fbx":
      return new (await import("three/examples/jsm/loaders/FBXLoader.js")).FBXLoader(manager).parse(buffer, "");
    case "dae": {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      // 坏文件时 ColladaLoader 返回 null（不是抛错）——给空组，交给上面的"没有几何体"分支
      return new ColladaLoader(manager).parse(new TextDecoder().decode(bytes), "")?.scene ?? new THREE.Group();
    }
    case "3ds":
      return new (await import("three/examples/jsm/loaders/TDSLoader.js")).TDSLoader(manager).parse(buffer, "");
    case "3mf":
      return new (await import("three/examples/jsm/loaders/3MFLoader.js")).ThreeMFLoader(manager).parse(buffer);
    case "amf":
      return new (await import("three/examples/jsm/loaders/AMFLoader.js")).AMFLoader(manager).parse(buffer);
    case "usd":
    case "usda":
    case "usdc":
    case "usdz":
      return new (await import("three/examples/jsm/loaders/USDLoader.js")).USDLoader(manager).parse(buffer, "");
    case "vrml":
    case "wrl":
      return new (await import("three/examples/jsm/loaders/VRMLLoader.js")).VRMLLoader(manager).parse(
        new TextDecoder().decode(bytes),
        "",
      );
    default:
      // 注册表只把 MODEL_EXTENSIONS 里的扩展名路由到这里，走到 default 说明两处不同步
      throw new Error(`没有可用的 3D 解码器：.${source.ext}`);
  }
}

async function renderModel(ctx: PreviewContext): Promise<PreviewInstance> {
  const wrap = document.createElement("div");
  wrap.className = "kb-model3d";
  ctx.container.replaceChildren(wrap);

  const stage = document.createElement("div");
  stage.className = "kb-model3d-stage";
  wrap.appendChild(stage);

  const bytes = await ctx.readBytes();
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  // WebGL 降级（照 OFV 的口径：创建失败不抛出去白屏，给诚实卡片 + 系统预览图）。
  // 放在解析之前：WebGL 都没有，就不必再解析一遍模型。
  let renderer: import("three").WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    stage.remove();
    return renderFallback(ctx, wrap, "当前设备不支持 WebGL，无法直接渲染 3D 模型。");
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  camera.position.set(2, 2, 3);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(3, 5, 4);
  scene.add(key);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const mesh = await parseModel(ctx, bytes);
  let triangleCount = 0;
  mesh.traverse((child) => {
    const asMesh = child as import("three").Mesh;
    const index = asMesh.geometry?.index;
    if (index) triangleCount += index.count / 3;
    else if (asMesh.geometry?.attributes?.position) triangleCount += asMesh.geometry.attributes.position.count / 3;
  });
  // 解析成功但一个面都没有（空模型 / 格式不完整）：别给一块空白画布
  if (!triangleCount) {
    stage.remove();
    return renderFallback(ctx, wrap, "没能从这个文件里读出几何体（模型可能为空，或格式不完整）。");
  }

  scene.add(mesh);

  // 自动取景：把模型装进相机（模型单位差异极大，写死距离必翻车）
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;

  /** 相机距离：按"适应窗口"算（视场角决定距离，不能用写死的倍数）。 */
  const fitDistance = (): number => {
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect || 1;
    const vertical = radius / Math.tan(fov / 2);
    const horizontal = radius / (Math.tan(fov / 2) * aspect);
    // 1.2 倍余量 ≈ 四周留 ~10% 空白（与图片/CAD/PDF 同一口径）
    return Math.max(vertical, horizontal) * 1.2;
  };

  const fitCamera = (): void => {
    const distance = fitDistance();
    const direction = camera.position.clone().sub(controls.target).normalize();
    if (!Number.isFinite(direction.x) || direction.lengthSq() === 0) direction.set(0.6, 0.5, 0.8).normalize();
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    camera.near = Math.max(radius / 1000, 0.001);
    camera.far = radius * 1000;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  };

  camera.position.set(1, 1, 1);
  camera.updateProjectionMatrix();
  fitCamera();
  ctx.onInfo?.(`${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} · ${Math.round(triangleCount)} 三角面`);
  ctx.onZoom?.({ percent: 100, fit: true });

  const resize = (): void => {
    const width = stage.clientWidth || 640;
    const height = stage.clientHeight || 480;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(stage);

  let raf = 0;
  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  return {
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
    },
    // 3D 的缩放是"相机推拉"：沿视线方向前后移动，保持朝向不变
    zoom(action) {
      if (action === "fit") {
        fitCamera();
        ctx.onZoom?.({ percent: 100, fit: true });
        return;
      }
      const factor = action === "in" ? 0.8 : 1.25;
      const offset = camera.position.clone().sub(controls.target);
      const distance = Math.max(fitDistance() * 0.05, offset.length() * factor);
      camera.position.copy(controls.target).add(offset.setLength(distance));
      controls.update();
      ctx.onZoom?.({ percent: Math.round((fitDistance() / distance) * 100), fit: false });
    },
  };
}

/** Blob → data URL（three 的 FileLoader 认 data:，且不产生网络请求）。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export const model3dPlugin = {
  id: "model3d",
  extensions: MODEL_EXTENSIONS,
  tools: ["zoom"] satisfies PreviewTool[],
  // 只用于 magic 通道：glb 的头 4 字节是 "glTF"；obj/stl/ply 是文本或无固定头，不靠它认领
  matchHead: (head: Uint8Array) =>
    head.length >= 4 && String.fromCharCode(head[0], head[1], head[2], head[3]) === GLB_MAGIC,
  render: renderModel,
};
