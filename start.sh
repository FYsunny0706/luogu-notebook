#!/usr/bin/env bash
# 洛谷刷题本 · macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  [错误] 没有找到 Node.js。"
  echo "  请先安装 Node.js 20 或更高版本：https://nodejs.org/"
  echo "  或用包管理器：brew install node / sudo apt install nodejs npm"
  echo
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  [警告] 当前 Node.js 版本是 $(node -v)，建议升级到 20 以上。"
fi

echo
echo "  正在启动「洛谷刷题本」..."
echo "  按 Ctrl+C 停止服务。"
echo

exec node server.mjs --open
