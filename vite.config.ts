import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import pkg from "./package.json";

// Tauri expects a fixed dev port and ignores the src-tauri folder.
export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag: string) => tag === "web-git-graph" } } })],
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
