import { describe, expect, it } from "vitest";
import { shortOrigin } from "../src/origin";

describe("shortOrigin", () => {
  it("GitHub https + .git", () => {
    expect(shortOrigin("https://github.com/tauri-apps/tauri.git")).toBe("tauri-apps/tauri");
  });
  it("GitHub 无 .git", () => {
    expect(shortOrigin("https://github.com/owner/repo")).toBe("owner/repo");
  });
  it("Gitee / GitLab 同规则", () => {
    expect(shortOrigin("https://gitee.com/o/r.git")).toBe("o/r");
    expect(shortOrigin("https://gitlab.com/o/r/")).toBe("o/r");
  });
  it("GitHub scp 语法同样短格式；未知主机原样", () => {
    expect(shortOrigin("git@github.com:o/r.git")).toBe("o/r");
    expect(shortOrigin("https://git.example.com/o/r.git")).toBe("https://git.example.com/o/r.git");
  });
});
