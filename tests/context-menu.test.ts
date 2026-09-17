// @vitest-environment jsdom
/**
 * 外壳右键策略：应用不该在非编辑区域弹出 WebView 的默认菜单
 * （dev 构建的 Reload/Inspect Element、macOS 的 Look Up/Translate/Services），
 * 但可编辑控件、链接、有选中文本时必须放行——那里用户要的是系统的剪切/复制/粘贴。
 */
import { describe, expect, it } from "vitest";
import { keepsNativeContextMenu } from "../src/context-menu";

function eventOn(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

function selectText(el: Element): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("右键策略", () => {
  it("外壳元素（树头/面板头/预览空白）→ 拦掉默认菜单", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(keepsNativeContextMenu(eventOn(div))).toBe(false);
    div.remove();
  });

  it("输入控件与可编辑区 → 放行（保留剪切/复制/粘贴）", () => {
    for (const tag of ["input", "textarea"]) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      expect(keepsNativeContextMenu(eventOn(el)), tag).toBe(true);
      el.remove();
    }
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.appendChild(inner);
    document.body.appendChild(editable);
    // 命中后代也要认（CM6 的 .cm-content 里还有一层 span）
    expect(keepsNativeContextMenu(eventOn(inner))).toBe(true);
    editable.remove();
  });

  it("链接 → 放行（保留「复制链接地址」）", () => {
    const link = document.createElement("a");
    link.href = "https://example.com";
    const label = document.createElement("span");
    link.appendChild(label);
    document.body.appendChild(link);
    expect(keepsNativeContextMenu(eventOn(label))).toBe(true);
    link.remove();
  });

  it("终端 → 放行（右键粘贴是终端里的习惯操作）", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const screen = document.createElement("div");
    xterm.appendChild(screen);
    document.body.appendChild(xterm);
    expect(keepsNativeContextMenu(eventOn(screen))).toBe(true);
    xterm.remove();
  });

  it("有选中文本 → 放行（PDF/代码块里选一段再右键仍能复制或查询）", () => {
    const pre = document.createElement("pre");
    pre.textContent = "选中我";
    document.body.appendChild(pre);
    expect(keepsNativeContextMenu(eventOn(pre))).toBe(false);
    selectText(pre);
    expect(keepsNativeContextMenu(eventOn(pre))).toBe(true);
    window.getSelection()!.removeAllRanges();
    pre.remove();
  });

  it("⌥ / ⌘ + 右键 → 放行（调试逃生口，Inspect Element 在里面）", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(keepsNativeContextMenu(eventOn(div, { altKey: true }))).toBe(true);
    expect(keepsNativeContextMenu(eventOn(div, { metaKey: true }))).toBe(true);
    div.remove();
  });
});
