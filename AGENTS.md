# AGENTS.md — Agent/开发者工程约定

> 本文件是任何 AI Agent 或开发者在本仓库工作时的**强制约定**。改动 UI 前先读
> 「字号与图标规范」；提交前必跑「质量门禁」。违反约定的改动会被要求返工。

## 字号与图标规范（强制引用遵守）

**规则：任何 `font-size` 声明禁止使用裸像素值（`font-size: Npx`），必须引用
以下五档 token。需要新档位时，先在 `styles.css :root` 扩 token 再使用——
不得私自引入体系外尺寸。**

Token 定义处：`src/styles.css` `:root`（单点修改全局生效）。

| Token | 尺寸 | 语义 | 典型用途 |
|---|---|---|---|
| `var(--font-xs)` | 10px | 徽标/角标 | chip、pill、计数角标 |
| `var(--font-sm)` | 11px | 次级元信息 | 日期、作者、meta 行、组头元数据 |
| `var(--font-md)` | 12px | **默认 UI 文本** | 按钮、输入框、下拉、面板标题、组头次级 |
| `var(--font-base)` | 13px | **内容主文本** | Issue/PR 标题行、组头名称、列表主文本 |
| `var(--font-xl)` | 17px | 大标题 | 详情页标题、About、对话框主标题 |

配套规则：

1. **图标统一 `--icon-size: 14px`**：所有 SVG 图标（EditorIcon 及各内联
   SVG）尺寸必须挂 `var(--icon-size, 14px)`，禁止写死 11/12/13px 等杂值；
   新图标一律走 `EditorIcon.vue`（14px viewBox 14，stroke=currentColor）。
2. **语义对齐**：内容主文本（Issue/PR 标题）= `--font-base` + 600 字重；
   次级元信息 = `--font-sm` + `--text-dim`——同类元素必须同档，不得
   「看着调」。
3. **层级示例**（列表面板）：组头名称 `font-base`/600 > 组头元数据
   `font-sm`/dim ≈ Issue meta 行 `font-sm` > 计数角标 `font-xs`。

## 质量门禁（提交前必跑）

```bash
pnpm gate   # i18n 键校验 / ESLint / Vitest / vue-tsc+build / Clippy / cargo test
```

- 门禁不绿不提交；ESLint 对裸字号的告警视同错误处理。
- 实机（UI/交互）验证配方见 `scripts/smoke.md`。
