#!/usr/bin/env bash
# 质量门禁——提交前一次跑完全部检查。任何一步失败即止。
# 用法：pnpm gate
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── 1/6 i18n 键与占位符校验"
node scripts/check-i18n.mjs

echo "── 2/6 ESLint（前端 lint）"
pnpm exec eslint .

echo "── 3/6 Vitest 纯逻辑测试"
pnpm exec vitest run

echo "── 4/6 类型检查 + 构建（vue-tsc + vite）"
pnpm exec vue-tsc --noEmit
pnpm exec vite build

echo "── 5/6 Clippy（Rust lint）"
(cd src-tauri && cargo clippy --all-targets --quiet)

echo "── 6/6 cargo test"
(cd src-tauri && cargo test --quiet)

echo "✅ 门禁全绿"
