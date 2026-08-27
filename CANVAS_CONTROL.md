# 把 Infinite Canvas 画布控制权交给其他 AI

本仓库的 `canvas-agent` 把"操作画布"能力封装成了标准接口，**任何 AI / agent / 脚本**都能接入，
不依赖 WorkBuddy。你（人类或另一个 AI）只需要选一种接入方式。

## 架构（30 秒看懂）

```
┌─────────────┐   HTTP(17371)   ┌──────────────┐   CDP/桥接   ┌──────────────────┐
│  任意 AI     │ ──────────────► │ canvas-agent  │ ──────────► │  画布网页(localhost:3000) │
│ (DeepSeek/  │                 │  node dist/   │             └──────────────────┘
│  Codex/Claude)│                │  index.js     │
└─────────────┘                 └──────────────┘
        │ MCP(stdio) 也是同一套工具
        ▼
 WorkBuddy / Codex CLI / 任何 MCP client
```

- **canvas-agent** 是本机一个常驻服务（当前跑在 `http://127.0.0.1:17371`），
  它连接画布网页、执行"读状态 / 建节点 / 生成视频 / 查询进度"等 34 个操作。
- 接入方只需要会发 HTTP，或会注册一个 MCP server，就能完全控制画布。

## 方式一：HTTP API（最通用，任何 AI 都能用）

画布工具统一入口：

```
POST http://127.0.0.1:17371/api/tools
Header: content-type: application/json
        x-canvas-agent-token: <token>
Body:   { "name": "<工具名>", "input": { ...参数 } }
```

token 从 `~/.infinite-canvas/canvas-agent.json` 的 `token` 字段读取（自动管理，无需手填）。

仓库里已备好零依赖 Python 客户端 **`canvas_control.py`**，DeepSeek harness / Claude / Cursor
只要让它执行 Python 即可：

```bash
# 列工具
python3 canvas_control.py tools

# 读画布状态（节点/连线/选区）
python3 canvas_control.py call canvas_get_state

# 图生视频（1:1，grok 模型）
python3 canvas_control.py call canvas_generate_video \
  '{"prompt":"海面波浪涌动","size":"1:1","seconds":"6","model":"Y85Qzl3lu_WniuZKa-Id8::grok-imagine-video-1.5","referenceNodeIds":["<图片节点id>"]}'

# 查询生成进度
python3 canvas_control.py call generation_get_status '{"scope":"canvas","nodeIds":["<节点id>"]}'
```

作为 Python 库用：

```python
from canvas_control import CanvasClient
c = CanvasClient()
state = c.call("canvas_get_state")
for node in state["nodes"]:
    print(node["id"], node["type"], node["metadata"].get("status"))
```

## 方式二：MCP 注册（适合 Codex CLI 等原生 MCP client）

canvas-agent 本身就是一个标准 MCP server（stdio 传输），任何 MCP client 都能直接接：

```bash
# 注册到 Codex CLI（README 官方推荐）
codex mcp add infinite-canvas \
  -- /Users/mac/.workbuddy/binaries/node/versions/22.22.2/bin/node \
  /Users/mac/WorkBuddy/2026-08-24-20-33-37/basketikun-infinite-canvas/repo/canvas-agent/dist/index.js mcp

# 不使用时移除
codex mcp remove infinite-canvas
```

之后 Codex 上下文里会出现 `canvas_*` 工具，直接说"看看画布上有什么"它就能自己调用。
其他支持 MCP 的 agent（Claude Desktop、Cursor、Cline 等）在各自的 MCP 配置里加同样的
`command` + `args` 即可。

## 方式三：让 AI 自己查代码（Agent 自举）

给另一个 AI 的指令模板（把下面这段放进它的 system prompt / 任务说明）：

> 你可以在本机 `/Users/mac/WorkBuddy/2026-08-24-20-33-37/basketikun-infinite-canvas/repo/`
> 自由读取代码。要操作画布，请：
> 1. 阅读 `canvas_control.py`（零依赖 Python 客户端，token 自动读取）
> 2. 用 `python3 canvas_control.py call canvas_get_state` 查看当前画布
> 3. 需要生成时调用 `canvas_generate_video` / `canvas_generate_image` 等工具
> 4. 用 `generation_get_status` 轮询进度
> 关键参数：模型用 `Y85Qzl3lu_WniuZKa-Id8::grok-imagine-video-1.5`（土豆渠道），
> 比例用 `1:1` / `9:16` / `16:9`，生成是异步的，提交后必须轮询状态直到 succeeded。

## 常用工具速查

| 工具 | 作用 |
|---|---|
| `canvas_get_state` | 读取画布全部节点、连线、选区、视口 |
| `canvas_generate_video` | 文生/图生视频（`referenceNodeIds` 传参考图） |
| `canvas_generate_image` | 生成图片 |
| `canvas_run_generation` | 触发指定配置节点生成 |
| `generation_get_status` | 查询生成任务进度（异步任务必查） |
| `canvas_apply_ops` | 批量增删改节点/连线/视口 |
| `workbench_video_get_config` | 读视频创作台当前参数和可选模型 |
| `site_navigate` | 导航画布网页 |

完整 34 个工具名见 `canvas_control.py` 里 `TOOL_NAMES` 列表。

## 注意事项

1. **token 是权限凭证**：`~/.infinite-canvas/canvas-agent.json` 里的 token 相当于画布的管理员密码，
   不要外发到不可信环境。
2. **Origin 白名单**：canvas-agent 默认只允许已授权的网页 Origin（当前 `http://localhost:3000`）
   连接；其他来源会被拒绝，除非清掉配置里的 `origins`。
3. **异步生成**：视频/图片生成是异步任务，提交后要轮询 `generation_get_status`
   直到 `succeeded`，不要只调一次就下结论。
