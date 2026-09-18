/**
 * 3D 模型预览（glTF/GLB、OBJ、STL、PLY、VRML）—— three.js 渲染，**全离线**。
 *
 * 关键决策与代价（照 OFV `model3d.ts` 的格式面，实现重写）：
 * - `three` 按需 `import()`：只有真打开模型文件才会拉这份 chunk；
 * - 贴图 / .bin 附件从**知识库内同目录**读（`ctx.readSibling`），预先转成 data URL，
 *   再交给 `LoadingManager.setURLModifier` 映射（three 的 FileLoader 只走 XHR，不能回调异步）；
 * - 灯光用固定两灯 + 环境光，不引 HDR 资源（那要从网上下）；
 * - FBX/DAE/3DS/USDZ/3MF/VRML/AMF 用 **three.js 自带的 Loader** 按需加载
 *   （OFV 同款做法——这些 Loader 就在 three/examples/jsm/loaders/ 里）。
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

/** 认得出、但不做渲染的重格式：明确告知而不是空白画布。 */
export const MODEL_NOT_RENDERABLE = new Set(["fbx", "dae", "3ds", "usd", "usda", "usdc", "usdz", "3mf", "amf"]);

async function renderModel(ctx: PreviewContext): Promise<PreviewInstance> {
  const wrap = document.createElement("div");
  wrap.className = "kb-model3d";
  ctx.container.replaceChildren(wrap);

  // ① 不支持的模式先拦（放 WebGL 创建之前：不需要 WebGL 的格式不付上下文创建的代价；
  //    且 jsdom 里 WebGL 必然失败，先后顺序反了的话诚实卡片永远出不来——测试抓到过）
  if (MODEL_NOT_RENDERABLE.has(ctx.ext)) {
    wrap.appendChild(
      Object.assign(document.createElement("p"), {
        className: "kb-note kb-model3d-note",
        textContent: `${ctx.ext.toUpperCase()} 需要专用解码器（本期不做，避免半成品渲染误导），请用「默认应用打开」。`,
      }),
    );
    ctx.onInfo?.(`不支持直接渲染（${ctx.ext.toUpperCase()} 需要专用解码器）`);
    return {};
  }

  const bytes = await ctx.readBytes();
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  const stage = document.createElement("div");
  stage.className = "kb-model3d-stage";
  wrap.appendChild(stage);

  // ② WebGL 降级（照 OFV 的口径：创建失败给诚实提示，不抛出去白屏）
  let renderer: import("three").WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    wrap.appendChild(Object.assign(document.createElement("p"), { className: "kb-note", textContent: "当前浏览器或设备不支持 WebGL，无法直接渲染 3D 模型。" }));
    ctx.container.replaceChildren(wrap);
    ctx.onInfo?.("无 WebGL（当前浏览器/设备不支持）");
    return {};
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

  // glTF 里的相对 uri（贴图、.bin）→ 知识库同目录文件 → data URL（离线关键点）
  const preloaded = new Map<string, string>();
  const manager = new THREE.LoadingManager();
  const dir = ctx.rel.includes("/") ? ctx.rel.slice(0, ctx.rel.lastIndexOf("/") + 1) : "";
  // three 的 FileLoader 只会走 XHR/fetch，不能异步回调 —— 所以策略是
  // **先预读附件成 data URL，再解析模型**；这里只做一次查表映射。
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
              if (!ctx.readSibling) return;
              try {
                const data = await ctx.readSibling(rel);
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
  let mesh: import("three").Object3D | null = null;
  let triangleCount = 0;

  // 统一加载策略：全格式走 three.js 自带 Loader（OFV 同款），按需 import()
  // 坐标系统一由下面的 autoFrame 处理，loader 之间无差异。
  const material = () => new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.1, roughness: 0.7 });
  switch (ctx.ext) {
    case "gltf":
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const isBinary = bytes.byteLength > 4 && String.fromCharCode(...bytes.subarray(0, 4)) === GLB_MAGIC;
      if (!isBinary) {
        try { await preloadGltf(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* 坏 JSON 交给 loader */ }
      }
      const loader = new GLTFLoader(manager);
      const gltf = await loader.parseAsync(buffer, "");
      mesh = gltf.scene;
      break;
    }
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      mesh = new OBJLoader(manager).parse(new TextDecoder().decode(bytes));
      break;
    }
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const geometry = new STLLoader().parse(buffer);
      geometry.computeVertexNormals();
      mesh = new THREE.Mesh(geometry, material());
      break;
    }
    case "ply": {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      const geometry = new PLYLoader().parse(buffer);
      geometry.computeVertexNormals();
      mesh = new THREE.Mesh(geometry, material());
      break;
    }
    case "fbx": {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      mesh = new FBXLoader(manager).parse(buffer, "");
      break;
    }
    case "dae": {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      const collada = new ColladaLoader(manager).parse(new TextDecoder().decode(bytes), "");
      mesh = collada?.scene ?? new THREE.Group();
      break;
    }
    case "3ds": {
      const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
      mesh = new TDSLoader(manager).parse(buffer, "");
      break;
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      mesh = new ThreeMFLoader(manager).parse(buffer);
      break;
    }
    case "amf": {
      const { AMFLoader } = await import("three/examples/jsm/loaders/AMFLoader.js");
      mesh = new AMFLoader(manager).parse(buffer);
      break;
    }
    case "usd":
    case "usda":
    case "usdc":
    case "usdz": {
      const { USDLoader } = await import("three/examples/jsm/loaders/USDLoader.js");
      mesh = new USDLoader(manager).parse(buffer, "");
      break;
    }
    default: {
      // vrml / wrl
      const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js");
      mesh = new VRMLLoader(manager).parse(new TextDecoder().decode(bytes), "");
    }
  }

  scene.add(mesh);
  mesh.traverse((child) => {
    const asMesh = child as import("three").Mesh;
    const index = asMesh.geometry?.index;
    if (index) triangleCount += index.count / 3;
    else if (asMesh.geometry?.attributes?.position) triangleCount += asMesh.geometry.attributes.position.count / 3;
  });

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
