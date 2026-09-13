#!/usr/bin/env bash
# 下载 gh CLI 二进制到 src-tauri/binaries/gh-<target-triple>
# （tauri.conf.json bundle.externalBin 的打包输入；见《从只读到读写》L15）
set -euo pipefail
cd "$(dirname "$0")/.."

dest_dir="src-tauri/binaries"
mkdir -p "$dest_dir"

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)  gh_os=macOS;  gh_arch=amd64; triple=aarch64-apple-darwin ;;
  Darwin/x86_64) gh_os=macOS;  gh_arch=amd64; triple=x86_64-apple-darwin ;;
  Linux/x86_64)  gh_os=linux;  gh_arch=amd64; triple=x86_64-unknown-linux-gnu ;;
  Linux/aarch64) gh_os=linux;  gh_arch=arm64; triple=aarch64-unknown-linux-gnu ;;
  MINGW*|MSYS*)  gh_os=windows; gh_arch=amd64; triple=x86_64-pc-windows-msvc ;;
  *) echo "不支持的平台: $(uname -s)/$(uname -m)"; exit 1 ;;
esac

version=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest | sed 's#.*/tag/##' | sed 's/^v//')
echo "gh latest: v${version}"

name="gh_${version}_${gh_os}_${gh_arch}"
case "$gh_os" in
  macOS)  ext=zip;    extract="unzip -q" ;;
  linux)  ext=tar.gz; extract="tar xzf" ;;
  windows) ext=zip;   extract="unzip -q" ;;
esac
url="https://github.com/cli/cli/releases/download/v${version}/${name}.${ext}"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
echo "下载 ${url}"
curl -fsSL -o "$workdir/pkg.$ext" "$url"
(cd "$workdir" && $extract "pkg.$ext")

src="$workdir/$name/bin/gh"
dest="$dest_dir/gh-$triple"
[ "$gh_os" = "windows" ] && dest="$dest_dir/gh-$triple.exe"
cp "$src" "$dest"
chmod +x "$dest"
echo "已就位: $dest"
