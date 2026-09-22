#!/usr/bin/env bash
# 质量门禁——分层执行，任何一步失败即止。分层规则与可暂缓边界见 AGENTS.md「质量门禁」。
#
#   pnpm gate        全量六步（提交前必跑，不可省）
#   pnpm gate:web    前端半套（六步中的 1–4）
#   pnpm gate:rust   Rust 半套（六步中的 5–6）
#   pnpm gate:fast   改动面最小集（小步改动的即时反馈，不替代上面三档）
set -euo pipefail
cd "$(dirname "$0")/.."

step_i18n()      { echo "── $1 i18n 键与占位符校验"; node scripts/check-i18n.mjs; }
step_eslint()    {
  local label="$1"; shift
  local targets=(.)
  if [ "$#" -gt 0 ]; then targets=("$@"); fi
  echo "── $label ESLint（前端 lint）"
  pnpm exec eslint "${targets[@]}"
}
step_vitest()        { local label="$1"; shift; echo "── $label Vitest 全量"; pnpm exec vitest run "$@"; }
step_vitest_related(){ local label="$1"; shift; echo "── $label Vitest（仅关联用例）"; pnpm exec vitest related --run "$@"; }
step_tsc()       { echo "── $1 类型检查（vue-tsc）"; pnpm exec vue-tsc --noEmit; }
step_tsc_build() { step_tsc "$1"; echo "── 构建（vite build）"; pnpm exec vite build; }
step_clippy()    { echo "── $1 Clippy（Rust lint）"; (cd src-tauri && cargo clippy --all-targets --quiet); }
step_cargotest() { echo "── $1 cargo test"; (cd src-tauri && cargo test --quiet); }

run_full() {
  echo "▶ 全量六步（提交前门禁）"
  step_i18n "1/6"
  step_eslint "2/6"
  step_vitest "3/6"
  step_tsc_build "4/6"
  step_clippy "5/6"
  step_cargotest "6/6"
  echo "✅ 门禁全绿"
}

run_web() {
  echo "▶ 前端半套（六步中的 1–4）"
  step_i18n "1/4"
  step_eslint "2/4"
  step_vitest "3/4"
  step_tsc_build "4/4"
  echo "✅ 前端半套全绿（Rust 侧 5–6 未验证）"
}

run_rust() {
  echo "▶ Rust 半套（六步中的 5–6）"
  step_clippy "1/2"
  step_cargotest "2/2"
  echo "✅ Rust 半套全绿（前端 1–4 未验证）"
}

# 改动面：已跟踪文件的暂存+未暂存改动，加上未跟踪文件
changed_files() {
  { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u
}

run_fast() {
  local web_files=() rust_files=()
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      src-tauri/*) rust_files+=("$f") ;;
      *.md|docs/*|LICENSE|.gitignore|.editorconfig) ;;  # 文档与元信息不影响代码检查
      *) web_files+=("$f") ;;
    esac
  done < <(changed_files)

  if [ "${#web_files[@]}" -eq 0 ] && [ "${#rust_files[@]}" -eq 0 ]; then
    echo "▶ 改动面：仅文档/元信息（或无改动）——无需跑代码检查"
    return 0
  fi
  echo "▶ 即时检查（改动面最小集）：前端 ${#web_files[@]} 个文件 / Rust ${#rust_files[@]} 个文件"

  if [ "${#web_files[@]}" -gt 0 ]; then
    step_i18n "·"
    local lint_files=() live_web=() deleted_web=0
    for f in "${web_files[@]}"; do
      if [ -e "$f" ]; then
        live_web+=("$f")
        case "$f" in *.ts|*.vue|*.js|*.mjs|*.cjs) lint_files+=("$f") ;; esac
      else
        deleted_web=$((deleted_web + 1))   # git 改动列表里含已删除文件
      fi
    done
    if [ "${#lint_files[@]}" -gt 0 ]; then
      step_eslint "·" "${lint_files[@]}"
    else
      echo "── ESLint：改动文件无 lint 覆盖，跳过"
    fi
    step_tsc "·"
    if [ "$deleted_web" -gt 0 ]; then
      # 删除的文件算不出「关联用例」，且 tests/ 不在 vue-tsc 覆盖内（tsconfig include 只有 src/**），
      # 悬空 import 只能靠全量用例兜住
      echo "── 改动含删除文件（$deleted_web 个）→ 跑全量用例"
      step_vitest "·"
    elif [ "${#live_web[@]}" -gt 0 ]; then
      step_vitest_related "·" "${live_web[@]}"
    fi
  fi

  if [ "${#rust_files[@]}" -gt 0 ]; then
    echo "── cargo check（编译错误快筛）"; (cd src-tauri && cargo check --quiet)
  fi

  echo "✅ 即时检查通过（本次未跑：vite build、cargo test 全量）"
  echo "   阶段收口：pnpm gate:web / pnpm gate:rust　　提交前：pnpm gate（全量六步）"
}

case "${1:-}" in
  ""|--full) run_full ;;
  --web)     run_web ;;
  --rust)    run_rust ;;
  --fast)    run_fast ;;
  -h|--help) sed -n '2,7p' "$0" ;;
  *) echo "未知参数：$1（可用：--web / --rust / --fast，缺省为全量六步）" >&2; exit 2 ;;
esac
