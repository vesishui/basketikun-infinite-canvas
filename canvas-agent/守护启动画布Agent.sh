#!/bin/zsh
# 守护启动 Canvas Agent —— 崩溃后自动重启，日志落盘
# 用法: ./守护启动画布Agent.sh        （前台运行，Ctrl+C 退出）
#       nohup ./守护启动画布Agent.sh >/dev/null 2>&1 &   （后台常驻）
#
# 用受控 Node 22（系统默认 Node 18 无法运行本项目）
NODE=/Users/mac/.workbuddy/binaries/node/versions/22.22.2/bin/node
cd "$(dirname "$0")" || exit 1

LOG_DIR="$HOME/.infinite-canvas/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/canvas-agent.log"

echo "=========================================="
echo "  Canvas Agent 守护启动中..."
echo "  端口: 17371  | 日志: $LOG_FILE"
echo "  崩溃后 3 秒自动重启 | Ctrl+C 退出"
echo "=========================================="

while true; do
  # 端口被占用说明已在运行，直接退出（避免双实例）
  if lsof -iTCP:17371 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "⚠️  17371 端口已被占用（Agent 可能已在运行），退出守护。"
    echo "   正在运行 PID: $(lsof -tiTCP:17371 -sTCP:LISTEN)"
    exit 0
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 canvas-agent ..."
  "$NODE" dist/index.js >>"$LOG_FILE" 2>&1
  code=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] canvas-agent 退出（代码 $code），3 秒后重启..."
  sleep 3
done
