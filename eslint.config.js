// ESLint flat config — Vue 3 + TypeScript. 双语言仓库的前端侧 lint；
// Rust 侧由 cargo clippy 把关（见 scripts/gate.sh）。
// essential 级别聚焦正确性，风格交给 prettier，避免对存量代码大翻底。
import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import globals from "globals";

export default defineConfigWithVueTs(
  { ignores: ["dist/**", "src-tauri/**", "node_modules/**", "coverage/**"] },
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
  { languageOptions: { globals: globals.browser } },
  {
    files: ["vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // 单文件组件命名（App.vue、settings 面板等）在此项目是有意为之。
      "vue/multi-word-component-names": "off",
    },
  },
);
