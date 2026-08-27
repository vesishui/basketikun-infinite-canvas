#!/usr/bin/env python3
"""
canvas_control.py — 让任何 AI / 脚本直接控制 Infinite Canvas 画布

背景
----
画布由本机 canvas-agent 提供两个控制入口：
  1. MCP（stdio）: node canvas-agent/dist/index.js mcp   —— WorkBuddy 等 MCP client 用
  2. HTTP API:     POST http://127.0.0.1:17371/api/tools —— 任何能发 HTTP 的 AI/脚本用（本文件）

本文件走第 2 条 HTTP 通道，零依赖（仅 Python 标准库），
DeepSeek harness / Claude Code / Cursor / 自定义 agent 都能直接用。

快速开始
--------
    python3 canvas_control.py tools                    # 列出全部可用工具
    python3 canvas_control.py call canvas_get_state    # 读取画布当前状态
    python3 canvas_control.py call canvas_generate_video '{"prompt":"海面波浪涌动","size":"1:1","seconds":"6"}'
    python3 canvas_control.py call generation_get_status '{"nodeIds":["<视频节点id>"],"scope":"canvas"}'

作为库使用
----------
    from canvas_control import CanvasClient
    c = CanvasClient()
    state = c.call("canvas_get_state")
    print(len(state["nodes"]), "个节点")

token 说明
----------
token 自动从 ~/.infinite-canvas/canvas-agent.json 读取，无需手动填写。
若 agent 换端口，用环境变量覆盖：CANVAS_AGENT_URL=http://127.0.0.1:17371
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# ---- 可配置项 -------------------------------------------------------------
DEFAULT_URL = "http://127.0.0.1:17371"
CONFIG_FILE = Path.home() / ".infinite-canvas" / "canvas-agent.json"


class CanvasError(RuntimeError):
    """画布工具调用失败。"""


def _load_token() -> str:
    """从 canvas-agent.json 读取连接 token。"""
    env = os.environ.get("CANVAS_AGENT_TOKEN")
    if env:
        return env.strip()
    if not CONFIG_FILE.exists():
        raise CanvasError(
            f"找不到配置文件 {CONFIG_FILE}，请先启动 canvas-agent "
            "（cd canvas-agent && node dist/index.js）"
        )
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise CanvasError(f"无法解析 {CONFIG_FILE}: {exc}") from exc
    token = data.get("token", "")
    if not token:
        raise CanvasError(f"{CONFIG_FILE} 中没有 token 字段")
    return token


def _base_url() -> str:
    return os.environ.get("CANVAS_AGENT_URL", DEFAULT_URL).rstrip("/")


class CanvasClient:
    """封装 canvas-agent 的 HTTP /api/tools 通道。"""

    def __init__(self, url: str | None = None, token: str | None = None):
        self.url = (url or _base_url()).rstrip("/")
        self.token = token or _load_token()
        self._endpoint = f"{self.url}/api/tools"

    def _post(self, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-canvas-agent-token": self.token,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise CanvasError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise CanvasError(
                f"无法连接 canvas-agent（{self.url}）：{exc.reason}。"
                "请确认已启动：cd canvas-agent && node dist/index.js"
            ) from exc

    def call(self, name: str, input_: dict | None = None) -> object:
        """调用画布工具，返回结果对象。失败抛 CanvasError。"""
        result = self._post({"name": name, "input": input_ or {}})
        if not result.get("ok"):
            raise CanvasError(result.get("error") or f"工具 {name} 调用失败")
        return result.get("result")

    def tools(self) -> list[str]:
        """返回可用工具名列表（若 HTTP 无此端点则给出手动清单）。"""
        try:
            res = self._post({"name": "_list_tools", "input": {}})
            if res.get("ok"):
                return res.get("result", [])
        except CanvasError:
            pass
        return TOOL_NAMES


# 供离线使用的完整工具清单（与 canvas-agent/src/canvas/schemas.ts 保持一致）
TOOL_NAMES = [
    "site_navigate",
    "canvas_list_projects",
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_export_snapshot",
    "canvas_apply_ops",
    "canvas_create_node",
    "canvas_create_attachment_nodes",
    "canvas_create_text_node",
    "canvas_create_text_nodes",
    "canvas_create_config_node",
    "canvas_create_image_prompt_flow",
    "canvas_create_generation_flow",
    "canvas_generate_text",
    "canvas_generate_image",
    "canvas_generate_video",
    "canvas_generate_audio",
    "canvas_update_node",
    "canvas_update_node_text",
    "canvas_move_nodes",
    "canvas_resize_node",
    "canvas_delete_nodes",
    "canvas_connect_nodes",
    "canvas_select_nodes",
    "canvas_set_viewport",
    "canvas_run_generation",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
]


def _main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0

    client = CanvasClient()

    if argv[0] == "tools":
        for name in client.tools():
            print(name)
        return 0

    if argv[0] == "call":
        if len(argv) < 2:
            print("用法: canvas_control.py call <工具名> ['<json 参数>']", file=sys.stderr)
            return 2
        name = argv[1]
        input_ = {}
        if len(argv) >= 3:
            input_ = json.loads(argv[2])
        result = client.call(name, input_)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print(f"未知命令: {argv[0]}（可用: tools / call）", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
