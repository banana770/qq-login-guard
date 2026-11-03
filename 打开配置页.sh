#!/usr/bin/env bash
# 打开配置页（macOS / Linux）。若守护已在运行会直接打开浏览器。
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 22+"
  exit 1
fi
exec node src/cli.mjs setup
