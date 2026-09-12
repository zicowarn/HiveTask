/** i18n t() 插值与语言切换契约测试。 */
import { beforeEach, describe, expect, it } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());
const { cycleLocale, locales, setLocale, t } = await import("../src/i18n");

describe("t", () => {
  it("替换 {name} 占位符", () => {
    setLocale("zh-CN");
    expect(t("common.author", { name: "alice" })).toBe("作者：alice");
  });

  it("语言切换即时生效（渲染期求值契约）", () => {
    setLocale("zh-CN");
    expect(t("common.refresh")).toBe("刷新");
    setLocale("en-US");
    expect(t("common.refresh")).toBe("Refresh");
    setLocale("zh-CN");
  });

  it("未知 key 原样返回，不抛错", () => {
    expect(t("no.such.key" as never)).toBe("no.such.key");
  });

  it("cycleLocale 按序轮换并回绕", () => {
    setLocale("zh-CN");
    cycleLocale();
    expect(t("common.refresh")).toBe("Refresh");
    cycleLocale();
    expect(t("common.refresh")).toBe("刷新");
    expect(locales).toHaveLength(2);
  });
});
