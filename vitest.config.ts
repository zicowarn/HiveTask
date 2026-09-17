import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// 纯逻辑测试（node 环境）：转译规则、键名归一化、菜单结构、i18n 插值。
// 不渲染组件——组件级验证走实机 smoke（scripts/smoke.md）。
export default defineConfig({
  // 组件级测试需要 SFC 编译（原先只跑纯逻辑，故未挂 Vue 插件）
  plugins: [vue()],
  test: {
    // 默认 node（纯逻辑）；需要 DOM 的用例在文件头用 `// @vitest-environment jsdom` 标注。
    environment: "node",
    // jsdom + CM6/Mermaid 的首帧在并行 worker 争用时可能晚到数秒；
    // 单测超时必须大于 waitForDom 的 6s，否则等待还没到就被判失败（实测踩过）。
    testTimeout: 20000,
    hookTimeout: 20000,
    include: ["tests/**/*.test.ts"],
  },
});
