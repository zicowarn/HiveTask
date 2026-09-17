/**
 * Markdown 命令表契约：工具条 / 快捷键 / 右键菜单共用一份定义，
 * 这里盯住"不能漂移"的几条——域名唯一、分组覆盖、图标齐备、快捷键不撞车。
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_GROUPS,
  EDITOR_COMMAND_GROUPS,
  ISSUE_TOOLBAR_KEYS,
  MARKDOWN_COMMANDS,
  commandByKey,
} from "../src/components/markdown-tools";

describe("Markdown 命令表", () => {
  it("key 唯一", () => {
    const keys = MARKDOWN_COMMANDS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每条命令都有图标与文案键", () => {
    for (const command of MARKDOWN_COMMANDS) {
      expect(command.icon, `${command.key} 缺图标`).toBeTruthy();
      expect(command.labelKey, `${command.key} 缺文案键`).toBeTruthy();
    }
  });

  it("wrap 命令必须成对给出前后缀", () => {
    for (const command of MARKDOWN_COMMANDS.filter((c) => c.kind === "wrap")) {
      expect(command.prefix, `${command.key} 缺前缀`).toBeDefined();
      expect(command.suffix, `${command.key} 缺后缀`).toBeDefined();
    }
  });

  it("line 命令必须给出行首标记，insert 必须给出文本", () => {
    for (const command of MARKDOWN_COMMANDS.filter((c) => c.kind === "line")) {
      expect(command.token, `${command.key} 缺标记`).toBeTruthy();
    }
    for (const command of MARKDOWN_COMMANDS.filter((c) => c.kind === "insert")) {
      expect(command.text, `${command.key} 缺插入文本`).toBeTruthy();
    }
  });

  it("分组里出现的 key 都存在于命令表，且无重复", () => {
    for (const groups of [COMMAND_GROUPS, EDITOR_COMMAND_GROUPS]) {
      const flat = groups.flat();
      expect(new Set(flat).size).toBe(flat.length);
      for (const key of flat) expect(commandByKey(key), `${key} 不在命令表`).toBeTruthy();
    }
  });

  it("Issue 编辑器键序与既有工具条一致（12 键）", () => {
    expect(ISSUE_TOOLBAR_KEYS).toEqual([
      "h", "b", "i", "quote", "code", "link",
      "ul", "ol", "task", "image", "mention", "undo",
    ]);
    for (const key of ISSUE_TOOLBAR_KEYS) expect(commandByKey(key)).toBeTruthy();
  });

  it("快捷键避开本应用已占用的键（⌘1..5 / ⌘R / ⌘O / ⌘,）", () => {
    const taken = ["⌘1", "⌘2", "⌘3", "⌘4", "⌘5", "⌘R", "⌘O", "⌘,", "⌘⇧C", "⌘⇧O"];
    for (const command of MARKDOWN_COMMANDS) {
      if (!command.shortcut) continue;
      expect(taken, `${command.key} 的 ${command.shortcut} 与应用键冲突`).not.toContain(command.shortcut);
    }
  });
});
