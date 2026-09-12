/** gh-errors 转译规则的回归测试——样本全部来自真实故障采集（见知识库）。 */
import { beforeEach, describe, expect, it } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());
// 动态导入：保证桩在模块顶层 detectLocale 之前生效。
const { isNetworkError, translateError } = await import("../src/gh-errors");

describe("translateError", () => {
  it("转译写权限拒绝（实测报文）", () => {
    const raw =
      "gh 退出码 Some(1): GraphQL: zicowarn does not have the correct permissions to execute `CloseIssue` (closeIssue)";
    expect(translateError(raw)).toBe("当前账号没有执行此操作的权限");
  });

  it("转译目标不存在（实测报文）", () => {
    const raw =
      "GraphQL: Could not resolve to an issue or pull request with the number of 99999999. (repository.issue)";
    expect(translateError(raw)).toBe("目标不存在或编号有误（可能已被删除）");
  });

  it("转译认证失效（实测报文）", () => {
    expect(translateError('gh 退出码 Some(1): {\n  "message": "Bad credentials"')).toBe(
      "gh 认证失效，请在终端执行 gh auth login",
    );
  });

  it("转译网络拒绝（实测报文）", () => {
    const raw =
      'Get "https://api.github.com/user": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused';
    expect(translateError(raw)).toBe("网络错误，无法连接 GitHub");
  });

  it("转译非仓库目录——git 输出是本地化中文，规则必须双语匹配", () => {
    expect(translateError("failed to run git: 致命错误：不是 git 仓库（或者任何父目录）：.git")).toBe(
      "未找到 Git 仓库或 remote，请确认已选择正确目录",
    );
    expect(translateError("打开 Git 仓库失败: could not find repository at '/x'")).toBe(
      "未找到 Git 仓库或 remote，请确认已选择正确目录",
    );
  });

  it("未知报文原样透传，绝不吞错", () => {
    const raw = "some totally unknown failure";
    expect(translateError(raw)).toBe(raw);
  });
});

describe("isNetworkError", () => {
  it("网络类失败 → 离线", () => {
    expect(isNetworkError("dial tcp 1.2.3.4: i/o timeout")).toBe(true);
    expect(isNetworkError("proxyconnect tcp: connection refused")).toBe(true);
  });

  it("其余失败（权限/认证）证明网络通 → 在线", () => {
    expect(isNetworkError("GraphQL: zicowarn does not have the correct permissions")).toBe(false);
    expect(isNetworkError("Bad credentials")).toBe(false);
  });
});
