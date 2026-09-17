// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DomFinder } from "../src/knowledge/preview/dom-find";

const make = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
};

describe("DomFinder", () => {
  it("同一文本节点内的多处命中", () => {
    const el = make("<p>河南神马，河南人</p>");
    const finder = new DomFinder(el);
    const result = finder.find("河南", { forward: true });
    expect(result).toEqual({ total: 2, current: 1 });
    expect(el.querySelectorAll("mark.kb-hit").length).toBe(2);
    expect(el.textContent).toBe("河南神马，河南人");
  });

  it("跨节点命中（标签把词切开）也要高亮", () => {
    const el = make("<p>河<strong>南</strong>神马</p>");
    const finder = new DomFinder(el);
    const result = finder.find("河南", { forward: true });
    expect(result.total).toBe(1);
    // 两个节点各插一个 mark，但算作**一次**命中
    expect(el.querySelectorAll("mark.kb-hit").length).toBe(2);
    expect(el.querySelectorAll("mark.kb-hit[data-hit='0']").length).toBe(2);
    expect(el.textContent).toBe("河南神马");
  });

  it("next/prev 回绕，并且当前命中只有一个", () => {
    const el = make("<p>aXbXc</p>");
    const finder = new DomFinder(el);
    finder.find("X", { forward: true });
    expect(el.querySelectorAll(".kb-hit-current").length).toBe(1);
    expect(finder.step({ forward: true })).toEqual({ total: 2, current: 2 });
    expect(finder.step({ forward: true })).toEqual({ total: 2, current: 1 });
    expect(finder.step({ forward: false })).toEqual({ total: 2, current: 2 });
    expect(el.querySelectorAll(".kb-hit-current").length).toBe(1);
  });

  it("大小写开关生效", () => {
    const el = make("<p>Abc abc</p>");
    expect(new DomFinder(el).find("abc", { forward: true }).total).toBe(2);
    const el2 = make("<p>Abc abc</p>");
    expect(new DomFinder(el2).find("abc", { forward: true, caseSensitive: true }).total).toBe(1);
  });

  it("清理后 DOM 回到原样（不留 mark、文本不变）", () => {
    const el = make("<p>河南<strong>神马</strong>河南</p>");
    const before = el.innerHTML;
    const finder = new DomFinder(el);
    finder.find("河南", { forward: true });
    finder.clear();
    expect(el.querySelectorAll("mark").length).toBe(0);
    expect(el.innerHTML).toBe(before);
  });

  it("无效正则当作无命中，不抛错", () => {
    const el = make("<p>abc</p>");
    expect(new DomFinder(el).find("([", { forward: true, regexp: true })).toEqual({ total: 0, current: 0 });
  });

  it("整词匹配只在拉丁文上有意义（中文不误伤）", () => {
    const el = make("<p>cat cats</p>");
    expect(new DomFinder(el).find("cat", { forward: true, wholeWord: true }).total).toBe(1);
  });

  it("不碰脚本/样式内容", () => {
    const el = make("<p>目标</p><style>.目标{}</style>");
    expect(new DomFinder(el).find("目标", { forward: true }).total).toBe(1);
  });
});
