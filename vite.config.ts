import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, cpSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import pkg from "./package.json";

interface VendorAsset {
  /** 站点根的 URL 前缀（代码里就是这么引的）。 */
  url: string;
  /** 源目录（相对仓库根）。 */
  from: string;
  /** 只拷这些文件（正则白名单）；省略 = 整目录拷。 */
  keepOnly?: RegExp[];
}

/** 只拷贝指定文件（许可文本这类"目录里还有别的东西"的场景）。 */
const LICENSE_ONLY = [/LICENSE-GPL-3\.0\.txt$/, /NOTICE-libredwg-web\.txt$/];


/**
 * 随包分发的**三方静态资源**：URL 前缀 → 源目录，一一对应，不经过打包器。
 *
 * 为什么不用 `vite-plugin-static-copy`：它会把源路径的目录结构**原样接在 dest 后面**
 * （`dest/pdfjs/cmaps/node_modules/pdfjs-dist/cmaps/*.bcmap`），运行时按
 * `/pdfjs/cmaps/...` 请求全部 404。这个问题在 dev 下不易察觉，直到真机打开中文 PDF
 * 才发现（PDF 缺 cmaps 就整篇乱码）。所以这里自己写：**URL 前缀怎么定，文件就放哪**。
 *
 * 两份资源：
 * - **pdfjs**：cmaps（CID→Unicode，中文必需）、standard_fonts（14 种标准字体）——
 *   OFV 默认把它们指向 jsdelivr，离线即失效；
 *   （pdfjs 5+ 才另带 `wasm/`，我们锁在 4.x legacy 构建，没有这个目录）
 * - **libredwg**：DWG 解析的 wasm（9.5M），只在打开 .dwg 时按 `locateFile` 请求，
 *   不进首屏、也不进 JS chunk。
 */
const VENDOR_ASSETS: VendorAsset[] = [
  { url: "/pdfjs/cmaps/", from: "node_modules/pdfjs-dist/cmaps" },
  { url: "/pdfjs/standard_fonts/", from: "node_modules/pdfjs-dist/standard_fonts" },
  { url: "/vendor/libredwg/", from: "node_modules/@mlightcad/libredwg-web/wasm" },
  // 许可随包：libredwg 是 GPL-3.0，分发时**必须**附许可全文与声明（GPL §4）
  { url: "/vendor/libredwg/licenses/", from: "resources/licenses", keepOnly: LICENSE_ONLY },
];
/**
 * 匹配顺序：**长前缀优先**。
 * 否则 `/vendor/libredwg/licenses/...` 会先命中 `/vendor/libredwg/`（wasm 目录），
 * 在它下面找不到文件就 fall through 到 SPA 首页（表现为"许可文件打不开"）。
 */
const VENDOR_BY_SPECIFICITY = [...VENDOR_ASSETS].sort((a, b) => b.url.length - a.url.length);
const MIME: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  // .bcmap / .pfb：pdfjs 自己按二进制读，给个中性的 octet-stream 即可
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
};

/** dev 与 preview 的中间件签名不同（ViteDevServer / PreviewServer），只取用到的部分。 */
interface MiddlewareHost {
  middlewares: {
    use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void;
  };
}

function vendorAssets(): Plugin {
  const root = fileURLToPath(new URL(".", import.meta.url));

  /** dev / preview：走中间件，直接从 node_modules 读（不落盘、不污染仓库）。 */
  const middleware = (server: MiddlewareHost): void => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? "").split("?")[0];
      const hit = VENDOR_BY_SPECIFICITY.find((asset) => path.startsWith(asset.url));
      if (!hit) return next();
      const base = resolve(root, hit.from);
      const file = resolve(base, decodeURIComponent(path.slice(hit.url.length)));
      // 目录穿越防护：解析后的路径必须还在源目录里
      if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
      if (hit.keepOnly && !hit.keepOnly.some((pattern) => pattern.test(file))) return next();
      res.setHeader("Content-Type", MIME[extname(file).toLowerCase()] ?? "text/plain");
      res.setHeader("Cache-Control", "no-cache");
      createReadStream(file).pipe(res);
    });
  };

  return {
    name: "hivetask:vendor-assets",
    configureServer: middleware,
    configurePreviewServer: middleware,
    // 构建：整目录平铺拷到 outDir 下的同名前缀（URL 前缀 = 输出路径）
    writeBundle(options) {
      const outDir = options.dir ?? resolve(root, "dist");
      for (const asset of VENDOR_ASSETS) {
        const target = join(outDir, asset.url);
        mkdirSync(target, { recursive: true });
        if (!asset.keepOnly) {
          cpSync(resolve(root, asset.from), target, { recursive: true });
        } else {
          for (const entry of readdirSync(resolve(root, asset.from))) {
            if (asset.keepOnly.some((pattern) => pattern.test(entry))) {
              cpSync(resolve(root, asset.from, entry), join(target, entry));
            }
          }
        }
        // 自检：拷完必须能直接躺在 URL 前缀下。少了这一步，目录被嵌套成
        // `<url>/node_modules/...` 也能"构建成功"，直到真机打开文件才发现 404
        // ——这个坑已经踩过一次（PDF 的 cmaps 全 404 → 中文乱码）。
        const landed = readdirSync(target);
        if (landed.length === 0) throw new Error(`[vendor-assets] ${asset.url} 没有拷到任何文件`);
        if (landed.includes("node_modules")) {
          throw new Error(`[vendor-assets] ${asset.url} 落位出现目录嵌套（URL 前缀与输出路径不一致）`);
        }
      }
      this.info?.(`vendor-assets: ${VENDOR_ASSETS.length} 组资源已按 URL 前缀落位`);
    },
  };
}

// Tauri expects a fixed dev port and ignores the src-tauri folder.
export default defineConfig({
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag: string) => tag === "web-git-graph" } } }),
    vendorAssets(),
  ],
  // App version (from package.json) for the status bar and About dialog.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
