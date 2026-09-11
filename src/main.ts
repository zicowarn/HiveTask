import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { initTheme } from "./theme";
import "./styles.css";

initTheme();
createApp(App).use(createPinia()).mount("#app");
