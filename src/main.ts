import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { initTheme } from "./theme";
import "./styles.css";

initTheme();

// 工作内容级 UI 偏好先落进 localStorage 镜像，再挂载——store 的首读都发生在挂载之后，
// 因此这里 await 一次就足够（开发态 / 安装版共用同一份 app.db，见 src/ui-prefs.ts）。
void (async () => {
  const { hydrateDurablePrefs } = await import("./ui-prefs");
  await hydrateDurablePrefs();
  createApp(App).use(createPinia()).mount("#app");
})();
