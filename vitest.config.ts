import { defineConfig } from "vitest/config";

// 纯逻辑测试（node 环境）：转译规则、键名归一化、菜单结构、i18n 插值。
// 不渲染组件——组件级验证走实机 smoke（scripts/smoke.md）。
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
