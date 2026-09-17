/**
 * 平台词汇共享映射：来源类型（repo.platform，来源 resolve_target 链）→
 * 平台显示名。与状态栏/菜单「在 GitHub 打开」类按钮同源，新增面板直接
 * 引用，避免各处维护私有表。
 */
import { t } from "../i18n";

const PLATFORM_LABELS: Record<string, string> = {
  github: "GitHub",
  gitee: "Gitee",
  gitea: "Gitea",
  gitlab: "GitLab",
};

/** 平台显示名；无平台（本地/未知）→ null（按钮应隐藏）。 */
export function platformName(platform?: string | null): string | null {
  if (!platform) return null;
  return PLATFORM_LABELS[platform] ?? null;
}

/** 「在 {平台} 打开」按钮文案；无平台 → 空串（调用方以 platformName 判隐藏）。 */
export function openOnLabel(platform?: string | null): string {
  const label = platformName(platform);
  return label ? t("common.openOnPlatform", { name: label }) : "";
}
