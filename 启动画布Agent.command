#!/bin/zsh
# 一键启动 Canvas Agent（双击运行，窗口保留日志）
cd "$(dirname "$0")/canvas-agent" || exit 1
echo "=========================================="
echo "  Canvas Agent 启动中..."
echo "  端口: 17371  | 项目: $(basename "$(dirname "$0")")"
echo "  关闭本窗口 = 停止 Agent"
echo "=========================================="
# 如果端口被占用，先提示
if lsof -iTCP:17371 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  检测到 17371 端口已被占用（Agent 可能已在运行）"
  echo "   正在运行的 PID: $(lsof -tiTCP:17371 -sTCP:LISTEN)"
  echo "   如需重启：先关闭旧进程，或直接 Ctrl+C 后重试"
  read -k 1 "?按任意键退出..."; echo; exit 0
fi
node dist/index.js
echo ""
echo "❌ Agent 已退出（代码 $?）"
read -k 1 "?按任意键关闭窗口..."
