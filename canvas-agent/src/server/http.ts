import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";

import { runClaudeTurn } from "../agent/claude.js";
import { archiveCodexThread, CodexSkillLookupError, configureCodexSkill, generateCodexSkillDraft, interruptCodexTurn, isRecoverableThreadError, listCodexModels, listCodexSkills, listCodexThreads, readCodexThread, resolveCodexApproval, resolveCodexSkill, resumeCodexThread, runCodexTurn, startCodexThread, summarizeCodexThread } from "../agent/codex.js";
import type { CodexReasoningEffort, CodexSkillSelector } from "../agent/codex-protocol.js";
import { messageMetadataStore } from "../agent/message-metadata.js";
import type { AgentAttachment, AgentPermissionMode } from "../agent/types.js";
import { AGENT_PROTOCOL_VERSION, CanvasSession } from "../canvas/session.js";
import { toolInputSchemas, toolDescriptions, type ToolName } from "../canvas/schemas.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DEFAULT_PORT, ensureSiteWorkspace, loadConfig, saveConfig, updateSiteWorkspace, type CanvasAgentConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { checkVersions } from "../version-check.js";
import { SkillStore, SkillStoreError } from "../skills/store.js";

// ===== 画布渠道直连对话：暴露给第三方模型的画布工具 =====
// 只暴露画布读写类工具（不含 site 导航 / workbench 自动化 / 素材上传），避免第三方模型操作页面跳转等重操作
const DIRECT_CHAT_TOOL_NAMES: ToolName[] = [
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_export_snapshot",
    "canvas_apply_ops",
    "canvas_create_node",
    "canvas_create_text_node",
    "canvas_create_text_nodes",
    "canvas_create_config_node",
    "canvas_create_image_prompt_flow",
    "canvas_create_generation_flow",
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
];
const DIRECT_CHAT_MAX_TOOL_ROUNDS = 8;

/** OpenAI 不允许 $ref/$defs，这里把 zod 转出的 schema 清洗成自包含 JSON Schema（record 字段替换为通用 object）。 */
function sanitizeOpenAiSchema(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(sanitizeOpenAiSchema);
    if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if ("$ref" in obj) return { type: "object", additionalProperties: {} };
        for (const key of ["anyOf", "oneOf"] as const) {
            if (Array.isArray(obj[key]) && obj[key].some((item) => item && typeof item === "object" && "$ref" in (item as Record<string, unknown>))) {
                return { type: "object", additionalProperties: {} };
            }
        }
        for (const key of Object.keys(obj)) obj[key] = sanitizeOpenAiSchema(obj[key]);
        return obj;
    }
    return node;
}

const DIRECT_CHAT_TOOL_DEFINITIONS = DIRECT_CHAT_TOOL_NAMES.map((name) => {
    const raw = zodToJsonSchema(toolInputSchemas[name], { target: "openAi" }) as Record<string, unknown>;
    delete raw.$schema;
    return {
        type: "function",
        function: {
            name,
            description: toolDescriptions[name],
            parameters: sanitizeOpenAiSchema(raw),
        },
    };
});

/** 启动仅监听本机的 Canvas Agent HTTP 服务。 */
export function startHttpServer() {
    const config = loadConfig(true);
    const port = Number(process.env.PORT) || Number(new URL(config.url).port) || DEFAULT_PORT;
    config.url = `http://127.0.0.1:${port}`;
    saveConfig(config);

    const initialWorkspace = ensureSiteWorkspace(config);
    const session = new CanvasSession(initialWorkspace.activeThreadId || "");
    const skillStore = new SkillStore(initialWorkspace.workspacePath);
    /** 将 Agent 事件广播到所属线程或全部网页。 */
    const emit = (type: string, payload: unknown) => {
        const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
        if (type === "skills_changed") {
            session.emitAll(type, value);
            return;
        }
        if (type === "agent_bootstrap" && value.phase === "preheat") {
            if (value.type === "mcp.startup") session.updateConversationMcp(String(value.name || ""), startupStatus(value.status), String(value.error || "") || null, String(value.failureReason || "") || null);
            if (value.type === "mcp.complete") session.completeConversationMcpInventory(mcpInventory(value.services));
        }
        const scope = session.codexBusy ? session.codexEventScope : { threadId: "", turnId: "", sourceClientId: "" };
        const threadId = String(value.threadId || value.thread_id || scope.threadId || ensureSiteWorkspace(config).activeThreadId || "");
        const turnId = String(value.turnId || value.turn_id || scope.turnId || "");
        const sourceClientId = String(value.sourceClientId || scope.sourceClientId || "");
        const data = {
            ...value,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            ...(turnId ? { turnId, turn_id: turnId } : {}),
            ...(sourceClientId ? { sourceClientId } : {}),
        };
        session.trackCodexEvent(type, data);
        threadId ? session.emitThread(type, threadId, data) : session.emitAll(type, data);
    };
    /** 保存并广播当前站点工作空间的活跃线程。 */
    const setActiveThread = (activeThreadId: string, payload: Record<string, unknown> = {}, preserveConversation = false) => {
        const workspace = updateSiteWorkspace(config, { activeThreadId: activeThreadId || undefined });
        if (!preserveConversation) session.activateConversation(activeThreadId, String(payload.sourceClientId || "") || undefined);
        if (!session.codexBusy && session.codexThreadId !== activeThreadId) session.setCodexState({ threadId: activeThreadId, turnId: "" });
        session.emitThread("workspace_changed", activeThreadId, { ...payload, activeThreadId, conversation: session.conversationStateSnapshot });
        return workspace;
    };
    let draftThreadStart: ReturnType<typeof startCodexThread> | null = null;
    let skillDraftRunning = false;
    const prepareDraftThread = (clientId: string, permission: AgentPermissionMode) => {
        if (draftThreadStart) return draftThreadStart;
        const workspace = ensureSiteWorkspace(config);
        let prepared!: ReturnType<typeof startCodexThread>;
        prepared = (async () => {
            emit("agent_bootstrap", { type: "codex.preparing", sourceClientId: clientId });
            try {
                const thread = await startCodexThread(emit, workspace.workspacePath, permission, true);
                if (draftThreadStart !== prepared) return thread;
                const threadId = String((thread as Record<string, unknown>).id || "");
                if (threadId && !ensureSiteWorkspace(config).activeThreadId) {
                    session.completeConversationPreparation(threadId);
                    setActiveThread(threadId, { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
                }
                return thread;
            } catch (error) {
                if (draftThreadStart === prepared) {
                    const text = error instanceof Error ? error.message : String(error);
                    session.failConversationPreparation(text);
                    emit("agent_bootstrap", { type: "codex.prepare_failed", sourceClientId: clientId, error: text });
                }
                throw error;
            } finally {
                if (draftThreadStart === prepared) draftThreadStart = null;
            }
        })();
        draftThreadStart = prepared;
        return prepared;
    };
    /** 恢复已有线程并等待完整 MCP 清单，供启动恢复和手动切换共用。 */
    const prepareExistingThread = async (threadId: string, clientId = "", permission: AgentPermissionMode = "request") => {
        const workspace = ensureSiteWorkspace(config);
        session.beginConversation({ conversationId: threadId, threadId, sourceClientId: clientId || undefined });
        emit("agent_bootstrap", { type: "codex.preparing", threadId, sourceClientId: clientId || undefined });
        const result = await resumeCodexThread(emit, threadId, workspace.workspacePath, permission, true);
        session.completeConversationPreparation(threadId);
        return result;
    };
    const failPreparedConversation = (error: unknown, threadId: string, clientId = "") => {
        const text = error instanceof Error ? error.message : String(error);
        session.failConversationPreparation(text);
        emit("agent_bootstrap", { type: "codex.prepare_failed", threadId, sourceClientId: clientId || undefined, error: text });
    };
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "30mb" }));
    // 请求日志：把请求（尤其 POST）彩色打印到终端，跳过 OPTIONS；不走 winston 避免污染文件日志。
    app.use((req, res, next) => {
        const startedAt = Date.now();
        res.on("finish", () => {
            if (req.method === "OPTIONS") return;
            const ms = Date.now() - startedAt;
            const method = (req.method || "GET").toUpperCase();
            const status = res.statusCode;
            const color = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
            const methodColor = method === "POST" ? "36" : method === "PUT" || method === "PATCH" ? "33" : method === "DELETE" ? "35" : "90";
            const statusColor = status >= 500 ? "31" : status >= 400 ? "33" : status >= 300 ? "36" : "32";
            let bodyInfo = "";
            if (req.body && typeof req.body === "object" && method !== "GET" && method !== "HEAD") {
                try {
                    const snapshot = JSON.stringify(req.body);
                    bodyInfo = snapshot.length > 600 ? ` ${snapshot.slice(0, 600)}…` : ` ${snapshot}`;
                } catch { /* 忽略序列化失败 */ }
            }
            console.log(`  ${color("90", new Date().toLocaleTimeString("zh-CN", { hour12: false }))} ${color(methodColor, method.padEnd(6))} ${req.originalUrl || req.url} ${color(statusColor, String(status))} ${color("90", ms + "ms")}${bodyInfo}`);
        });
        next();
    });
    app.use((req, res, next) => {
        if (!logger.enabled) return next();
        const startedAt = Date.now();
        const url = requestUrl(req, config);
        res.on("finish", () => {
            if (req.method === "OPTIONS" || (res.statusCode < 400 && ["/health", "/canvas/state", "/canvas/activate"].includes(url.pathname))) return;
            logger.debug(`HTTP ${req.method} ${url.pathname}`, { status: res.statusCode, durationMs: Date.now() - startedAt });
        });
        next();
    });
    app.use((req, res, next) => {
        const url = requestUrl(req, config);
        if (!setCors(req, res, url, config)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });
    app.get("/health", (_req, res) => res.json(session.health()));
    app.get("/config", (_req, res) => res.json({ ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, url: config.url, hasToken: true }));
    app.use((req, res, next) => {
        if (validToken(req, requestUrl(req, config), config.token)) return next();
        res.status(401).json({ ok: false, error: "invalid token" });
    });
    app.get("/events", (req, res) => {
        session.openEvents(requestUrl(req, config), res, ensureSiteWorkspace(config).activeThreadId || "");
    });
    app.post("/canvas/state", (req, res) => {
        session.updateState(req.body, String(req.query.clientId || "") || undefined);
        res.json({ ok: true });
    });
    app.post("/canvas/activate", (req, res) => {
        session.activateClient(String(req.query.clientId || ""));
        res.json({ ok: true });
    });
    app.post("/canvas/result", (req, res) => {
        const ok = session.resolveResult(String(req.query.clientId || ""), req.body);
        res.status(ok ? 200 : 409).json({ ok });
    });
    app.get("/agent/attachments/:attachmentId", route(async (req, res) => {
        const attachment = session.getTurnAttachment(String(req.query.clientId || ""), routeParam(req.params.attachmentId));
        const data = attachment.dataUrl.split(",", 2)[1];
        if (!data) throw new Error("图片附件内容无效");
        res.setHeader("Cache-Control", "no-store");
        res.type(attachment.type).send(Buffer.from(data, "base64"));
    }));
    app.get("/agent/message-assets/:messageKey/:assetFile", route(async (req, res) => {
        const asset = await messageMetadataStore.readAsset(routeParam(req.params.messageKey), routeParam(req.params.assetFile));
        if (!asset) return void res.status(404).json({ ok: false, error: "message asset not found" });
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.type(asset.contentType).send(asset.data);
    }));
    app.post("/agent/local-file/reveal", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath)) return res.status(400).json({ ok: false, error: "文件路径必须是绝对路径" });
        const file = await stat(filePath);
        await revealLocalFile(filePath, file.isDirectory());
        res.json({ ok: true });
    }));
    app.post("/agent/local-image", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath) || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(filePath)) return res.status(400).json({ ok: false, error: "图片路径无效" });
        const file = await stat(filePath);
        if (!file.isFile()) return res.status(400).json({ ok: false, error: "图片文件无效" });
        res.setHeader("Cache-Control", "no-store");
        res.type(path.extname(filePath)).send(await readFile(filePath));
    }));
    app.post("/api/tools", route(async (req, res) => res.json({ ok: true, result: await session.callTool(req.body?.name, req.body?.input || {}) })));
    // 画布渠道直连对话：前端把画布配置的渠道（baseUrl/apiKey/model）传过来，
    // 后端调用 OpenAI 兼容的 /chat/completions，绕过 Codex（第三方渠道经常换配置，画布改了这里自动跟着用）。
    // 支持 tools：第三方模型可多轮调用画布工具（创建/修改/选中节点等），工具经 session.callTool 转发到已连接画布执行。
    app.post("/agent/direct/chat", route(async (req, res) => {
        const { baseUrl, apiKey, model, messages, tools } = req.body || {};
        if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
            res.status(400).json({ ok: false, error: "缺少 baseUrl/apiKey/model/messages" });
            return;
        }
        const normalizedBase = String(baseUrl).trim().replace(/\/+$/, "");
        // 与前端 buildApiUrl 一致：baseUrl 不以 /v1 结尾时自动补 /v1（画布渠道常填 https://xxx.com/ 不带 /v1）
        const apiBase = normalizedBase.toLowerCase().endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
        const target = `${apiBase}/chat/completions`;
        // 启用工具：前端可传 tools 数组（与白名单取交集），不传则默认全部暴露
        const enabledTools = Array.isArray(tools) && tools.length ? (tools as string[]).filter((name) => (DIRECT_CHAT_TOOL_NAMES as readonly string[]).includes(name)) : [];
        const toolDefs = enabledTools.length ? DIRECT_CHAT_TOOL_DEFINITIONS.filter((def) => enabledTools.includes(def.function.name)) : [];
        // MOCK 模式：跳过上游，返回固定回复，用于测试前端渲染链路（启动时设 MOCK_CHAT=1）
        if (process.env.MOCK_CHAT === "1") {
            const lastUser = [...(messages as Array<{ role: string; content: string }>)].reverse().find((m) => m.role === "user");
            const reply = `【MOCK 测试回复】收到消息：${(lastUser?.content || "").slice(0, 60)}。这是写死的回复，说明前端渲染链路正常。`;
            res.json({ ok: true, content: reply });
            return;
        }
        type ToolExec = { name: string; input: unknown; ok: boolean; summary?: string; error?: string };
        const executedTools: ToolExec[] = [];
        const summarize = (value: unknown) => {
            const text = JSON.stringify(value);
            return text.length > 300 ? `${text.slice(0, 300)}…` : text;
        };
        let workingMessages = messages as Array<Record<string, unknown>>;
        let finalContent = "";
        // 工具调用循环：模型可多轮调用画布工具（会经画布页面的确认卡片），最多 DIRECT_CHAT_MAX_TOOL_ROUNDS 轮
        roundLoop: for (let round = 0; round <= DIRECT_CHAT_MAX_TOOL_ROUNDS; round++) {
            for (let attempt = 0; attempt < 5; attempt++) {
                let upstream;
                try {
                    upstream = await fetch(target, {
                        method: "POST",
                        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
                        body: JSON.stringify({ model, messages: workingMessages, ...(toolDefs.length ? { tools: toolDefs, tool_choice: "auto" } : {}), stream: false }),
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    res.status(502).json({ ok: false, error: `上游连接失败: ${message}` });
                    return;
                }
                if (!upstream.ok) {
                    const text = await upstream.text().catch(() => "");
                    // 上游临时故障（503/429/5xx）：记录并重试，而不是直接失败
                    if ((upstream.status === 503 || upstream.status === 429 || upstream.status >= 500) && attempt < 4) {
                        logger.warn(`[direct-chat] 上游 ${upstream.status}（第 ${attempt + 1} 次），稍后重试: ${text.slice(0, 200)}`);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        continue;
                    }
                    res.status(502).json({ ok: false, error: `上游返回 ${upstream.status}: ${text.slice(0, 300)}` });
                    return;
                }
                const data = (await upstream.json().catch(async () => {
                    // 上游返回非 JSON，记录原始响应用于诊断
                    const text = await upstream.text().catch(() => "");
                    logger.warn(`[direct-chat] 上游响应非 JSON: status=${upstream.status} contentType=${upstream.headers.get("content-type")} body=${text.slice(0, 200)}`);
                    return {};
                })) as Record<string, unknown>;
                const message = (data.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined || {};
                const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []) as Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
                if (!toolCalls.length) {
                    // 无工具调用：最终文本（推理模型 content 可能为空，用 reasoning_content 兜底）
                    const content = (message.content || message.reasoning_content || "") as string;
                    if (content) {
                        finalContent = content;
                        break roundLoop;
                    }
                    // 上游偶发返回空内容，记录原始响应并重试
                    const raw = JSON.stringify(data).slice(0, 500);
                    logger.warn(`[direct-chat] 上游第 ${attempt + 1} 次返回空 content: ${raw}`);
                    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500));
                    continue;
                }
                // 有工具调用：执行并继续（画布页面会弹确认卡片，审批后工具才真正执行）
                if (round >= DIRECT_CHAT_MAX_TOOL_ROUNDS) {
                    finalContent = (message.content || message.reasoning_content || "已达到工具调用上限") as string;
                    break roundLoop;
                }
                const toolResults: Array<Record<string, unknown>> = [];
                for (const call of toolCalls) {
                    const name = String(call?.function?.name || "");
                    let input: unknown = {};
                    try { input = JSON.parse(String(call?.function?.arguments || "{}")); } catch { /* 参数解析失败时按空对象执行 */ }
                    let result: unknown;
                    let ok = true;
                    try {
                        if (!name || !DIRECT_CHAT_TOOL_NAMES.includes(name as ToolName)) throw new Error(`画布工具不可用：${name}`);
                        logger.info(`[direct-chat] 执行画布工具`, { name, input });
                        result = await session.callTool(name, input);
                    } catch (error) {
                        ok = false;
                        const message = error instanceof Error ? error.message : String(error);
                        result = { error: message };
                        logger.warn(`[direct-chat] 工具执行失败`, { name, error: message });
                    }
                    executedTools.push({ name, input, ok, ...(ok ? { summary: summarize(result) } : { error: summarize(result) }) });
                    toolResults.push({ role: "tool", tool_call_id: String(call?.id || ""), content: JSON.stringify(result) });
                }
                // 先把含 tool_calls 的 assistant 消息推入对话，再推 tool 结果（OpenAI 协议要求 tool 消息前必须有 tool_calls）
                workingMessages = [...workingMessages, message as Record<string, unknown>, ...toolResults];
                break; // 本轮工具已执行，进入下一轮
            }
        }
        res.json({ ok: true, content: finalContent, toolCalls: executedTools });
    }));
    // 画布渠道图片/视频/音频等 OpenAI 兼容接口的中继：浏览器直连第三方会被 CORS 拦截，
    // 前端把请求发给本端点，后端转发到第三方（图片生成/编辑、视频创建/查询/下载都走这里）。
    app.post("/agent/direct/relay", route(async (req, res) => {
        const { baseUrl, apiKey, method = "POST", path, body, kind = "json" } = req.body || {};
        if (!path || typeof path !== "string") {
            res.status(400).json({ ok: false, error: "缺少 path" });
            return;
        }
        const rawPath = String(path);
        const fullUrl = /^https?:\/\//i.test(rawPath);
        const target = fullUrl ? rawPath : (() => {
            const normalizedBase = String(baseUrl || "").trim().replace(/\/+$/, "");
            if (!normalizedBase) return rawPath;
            const apiBase = normalizedBase.toLowerCase().endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
            return `${apiBase}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`;
        })();
        const upstreamMethod = String(method).toUpperCase();
        // 合并大小写不敏感：自定义 headers 里的 Authorization 会与 authHeaders 的小写 authorization
        // 形成两个不同 key，fetch 会把两个 Authorization 头都发给上游，导致 401 Invalid token。
        const customHeaders = (req.body && typeof req.body === "object" && (req.body as Record<string, unknown>).headers && typeof (req.body as Record<string, unknown>).headers === "object")
            ? (req.body as Record<string, unknown>).headers as Record<string, string>
            : {};
        const mergedAuthHeaders: Record<string, string> = {};
        if (apiKey) mergedAuthHeaders["authorization"] = `Bearer ${String(apiKey)}`;
        for (const [key, value] of Object.entries(customHeaders)) {
            // 覆盖同义 header（忽略大小写），保留脚本自定义 header 的原始写法
            const duplicateKey = Object.keys(mergedAuthHeaders).find((existing) => existing.toLowerCase() === key.toLowerCase());
            if (duplicateKey) delete mergedAuthHeaders[duplicateKey];
            mergedAuthHeaders[key] = value;
        }
        const authHeaders = mergedAuthHeaders;
        let upstream; // 由 fetch 赋值推断为全局 Response（不能用 Express 的 Response 类型）
        try {
            if (kind === "form") {
                const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
                const form = new FormData();
                const fields = (payload.fields || {}) as Record<string, unknown>;
                for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
                const files = (Array.isArray(payload.files) ? payload.files : []) as Array<{ name: string; filename?: string; dataUrl?: string }>;
                for (const file of files) {
                    const match = String(file.dataUrl || "").match(/^data:([^;]+);base64,(.*)$/s);
                    if (!match) continue;
                    form.append(file.name, new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), file.filename || "file.png");
                }
                upstream = await fetch(target, { method: upstreamMethod, headers: { ...authHeaders, ...customHeaders }, body: form });
            } else if (kind === "blob") {
                upstream = await fetch(target, { method: upstreamMethod, headers: { ...authHeaders, ...customHeaders } });
            } else {
                const mergedHeaders: Record<string, string> = { ...authHeaders };
                if (!Object.keys(mergedHeaders).some((key) => key.toLowerCase() === "content-type")) mergedHeaders["content-type"] = "application/json";
                upstream = await fetch(target, {
                    method: upstreamMethod,
                    headers: mergedHeaders,
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
            }
        } catch (error) {
            res.status(502).json({ ok: false, error: `上游连接失败: ${error instanceof Error ? error.message : String(error)}` });
            return;
        }
        if (!upstream.ok) {
            const text = await upstream.text().catch(() => "");
            res.status(upstream.status).type("application/json").send(JSON.stringify({ ok: false, error: `上游返回 ${upstream.status}: ${text.slice(0, 300)}` }));
            return;
        }
        if (kind === "blob") {
            const arrayBuffer = await upstream.arrayBuffer();
            const contentType = upstream.headers.get("content-type") || "application/octet-stream";
            res.json({ ok: true, data: Buffer.from(arrayBuffer).toString("base64"), contentType });
            return;
        }
        const text = await upstream.text().catch(() => "");
        res.type(upstream.headers.get("content-type") || "application/json").send(text);
    }));
    app.get("/agent/codex/workspace", (_req, res) => {
        const workspace = ensureSiteWorkspace(config);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot });
    });
    app.get("/agent/codex/models", route(async (_req, res) => res.json({ ok: true, ...(await listCodexModels(emit)) })));
    app.get("/agent/codex/skills", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const result = await listCodexSkills(emit, workspace.workspacePath, String(req.query.forceReload || "") === "1");
        res.json({ ok: true, data: result.skills.map((skill) => ({ ...skill, managed: skillStore.isManagedPath(skill.path) })), errors: result.errors });
    }));
    app.post("/agent/codex/skills/draft", codexMutation(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const source = String(req.body?.source || "");
        if (source !== "conversation" && source !== "canvas") return res.status(400).json({ ok: false, error: "Skill 草稿来源无效" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const previousCodexState = session.codexStateSnapshot;
        skillDraftRunning = true;
        try {
            if (source === "conversation") {
                const threadId = String(req.body?.threadId || "");
                if (!threadId) return res.status(409).json({ ok: false, error: "当前没有可提炼的对话" });
                if (threadId !== (workspace.activeThreadId || "")) return res.status(409).json({ ok: false, error: "当前对话已在其他页面切换，请同步后重试" });
                const history = await readCodexThread(emit, threadId, workspace.workspacePath);
                if (!history.messages.some((message) => message.role === "user" && message.turnId)) return res.status(409).json({ ok: false, error: "当前对话还没有可提炼的已完成内容" });
                session.setCodexState({ busy: true, threadId, turnId: "" }, { preserveReplay: true });
                const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, threadId, model, effort });
                if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
                return res.json({ ok: true, data });
            }
            const snapshot = session.canvasStateForClient(clientId);
            if (!snapshot || (snapshot as Record<string, unknown>).hasCanvas === false) return res.status(409).json({ ok: false, error: "当前页面没有可提炼的画布" });
            session.setCodexState({ busy: true, threadId: workspace.activeThreadId || "", turnId: "" }, { preserveReplay: true });
            const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, snapshot, model, effort });
            if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
            return res.json({ ok: true, data });
        } finally {
            skillDraftRunning = false;
            session.setCodexState(previousCodexState, { preserveReplay: true });
        }
    }));
    app.get("/agent/codex/skills/:name", route(async (req, res) => {
        res.json({ ok: true, data: await skillStore.get(routeParam(req.params.name)) });
    }));
    app.post("/agent/codex/skills", codexMutation(async (req, res) => {
        const data = await skillStore.create(req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.status(201).json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/enabled", codexMutation(async (req, res) => {
        if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: "Skill 启用状态无效" });
        const workspace = ensureSiteWorkspace(config);
        const selector = skillSelector(req.body);
        if (selector.name !== routeParam(req.params.name)) return res.status(400).json({ ok: false, error: "Skill 选择无效" });
        const data = await configureCodexSkill(emit, workspace.workspacePath, selector, req.body.enabled);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/delete", codexMutation(async (req, res) => {
        await skillStore.delete(routeParam(req.params.name), String(req.body?.expectedRevision || ""));
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true });
    }));
    app.post("/agent/codex/skills/:name", codexMutation(async (req, res) => {
        const data = await skillStore.update(routeParam(req.params.name), req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.get("/agent/codex/threads", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const result = await listCodexThreads(emit, { cwd: workspace.workspacePath, searchTerm: String(req.query.searchTerm || "") });
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...result });
    }));
    app.post("/agent/codex/threads/new", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        const thread = await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode));
        res.json({ ok: true, workspace: ensureSiteWorkspace(config), conversation: session.conversationStateSnapshot, thread: summarizeCodexThread(thread), messages: [] });
    }));
    app.post("/agent/codex/threads/reset", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode));
        res.json({ ok: true, workspace: ensureSiteWorkspace(config), conversation: session.conversationStateSnapshot });
    }));
    app.get("/agent/codex/threads/:threadId", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const threadId = routeParam(req.params.threadId);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...(await readCodexThread(emit, threadId, workspace.workspacePath)) });
    }));
    app.post("/agent/codex/history/ack", (req, res) => {
        const threadId = String(req.body?.threadId || "");
        const turnIds = Array.isArray(req.body?.turnIds) ? req.body.turnIds.map(String) : [];
        session.acknowledgeCodexHistory(threadId, turnIds);
        res.json({ ok: true });
    });
    app.post("/agent/codex/threads/:threadId/resume", codexMutation(async (req, res) => {
        const threadId = routeParam(req.params.threadId);
        const clientId = String(req.body?.clientId || "");
        try {
            const result = await prepareExistingThread(threadId, clientId, permissionMode(req.body?.permissionMode));
            const nextWorkspace = setActiveThread(threadId, { sourceClientId: clientId }, true);
            res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot, ...result });
        } catch (error) {
            failPreparedConversation(error, threadId, clientId);
            throw error;
        }
    }));
    app.post("/agent/codex/threads/:threadId/delete", codexMutation(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const threadId = routeParam(req.params.threadId);
        await archiveCodexThread(emit, threadId, workspace.workspacePath);
        const nextWorkspace = setActiveThread(workspace.activeThreadId === threadId ? "" : workspace.activeThreadId || "", { sourceClientId: String(req.body?.clientId || "") });
        res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot });
    }));
    app.post("/agent/codex/turn", codexMutation(async (req, res) => {
        const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
        const workspace = ensureSiteWorkspace(config);
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起任务的网页已断开，请重新连接后再试" });
        const requestedThreadId = String(req.body?.threadId || "");
        const activeThreadId = workspace.activeThreadId || "";
        const conversation = session.conversationStateSnapshot;
        const requestedConversationId = String(req.body?.conversationId || "");
        const expectedRevision = Number(req.body?.expectedRevision || 0);
        if (requestedThreadId !== activeThreadId || conversation.threadId !== activeThreadId || (requestedConversationId && requestedConversationId !== conversation.conversationId) || (expectedRevision && expectedRevision !== conversation.revision)) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_STALE", error: "当前会话已切换，已同步最新状态，请确认后重试", state: conversation });
        }
        if (!activeThreadId || !["ready", "warning"].includes(conversation.status)) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_NOT_READY", error: "Codex 对话仍在初始化，请等待 MCP 加载完成", state: conversation });
        }
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const skill = req.body?.skill === undefined ? undefined : await resolveCodexSkill(emit, workspace.workspacePath, skillSelector(req.body.skill), true);
        const messageId = String(req.body?.messageId || Date.now());
        const messageText = String(req.body?.messageText || prompt || `发送了 ${attachments.length} 张图片`);
        const messageMetadata = await messageMetadataStore.recordPending(messageId, req.body?.messageMetadata);
        let threadId = activeThreadId;
        logger.info("Codex turn accepted", { threadId: req.body?.threadId, model: model || "default", reasoningEffort: effort || "default", promptLength: prompt.length, attachmentCount: attachments.length });
        session.bindClient(clientId);
        session.markConversationRunning(threadId);
        session.setCodexState({ busy: true, threadId, turnId: "" });
        try {
            let turnId = "";
            const attachmentRefs = session.setTurnAttachments(clientId, attachments);
            session.emitThread("chat_message", threadId, {
                sourceClientId: clientId,
                message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
            });
            let chatTurnId = "";
            /** 将包装层日志和兜底错误固定广播到当前 turn。 */
            const lifecycleEmit = (type: string, payload: unknown) => {
                const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
                const eventThreadId = String(value.threadId || value.thread_id || threadId);
                const eventTurnId = String(value.turnId || value.turn_id || turnId);
                const sourceClientId = String(value.sourceClientId || clientId);
                session.emitThread(type, eventThreadId, {
                    ...value,
                    threadId: eventThreadId,
                    thread_id: eventThreadId,
                    ...(eventTurnId ? { turnId: eventTurnId, turn_id: eventTurnId } : {}),
                    ...(sourceClientId ? { sourceClientId } : {}),
                });
            };
            void runCodexTurn(withAttachmentContext(prompt, attachmentRefs), lifecycleEmit, attachments, {
                threadId,
                cwd: workspace.workspacePath,
                permissionMode: permissionMode(req.body?.permissionMode),
                model,
                effort,
                ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
                messageText,
                appEmit: emit,
                onStart: () => session.bindClient(clientId),
                onThread: (actualThreadId) => {
                    const threadChanged = actualThreadId !== threadId;
                    void messageMetadataStore.bindThread(messageId, actualThreadId).catch((error) => logger.warn("Failed to bind message metadata to thread", { clientMessageId: messageId, threadId: actualThreadId, error }));
                    if (actualThreadId !== threadId) {
                        threadId = actualThreadId;
                        setActiveThread(threadId, { emptyThread: true, sourceClientId: clientId });
                    }
                    session.markConversationRunning(threadId);
                    session.setCodexState({ busy: true, threadId, turnId: "" });
                    if (threadChanged) {
                        session.emitThread("chat_message", threadId, {
                            sourceClientId: clientId,
                            message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                },
                onTurn: (actualTurnId) => {
                    turnId = actualTurnId;
                    void messageMetadataStore.bindTurn(messageId, threadId, turnId).catch((error) => logger.warn("Failed to bind message metadata to turn", { clientMessageId: messageId, threadId, turnId, error }));
                    if (chatTurnId !== turnId) {
                        chatTurnId = turnId;
                        session.emitThread("chat_message", threadId, {
                            turnId,
                            sourceClientId: clientId,
                            message: { id: `${threadId}:${turnId}:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId, role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                    logger.info("Codex turn started", { threadId, turnId, model: model || "default", reasoningEffort: effort || "default" });
                    session.setCodexState({ busy: true, threadId, turnId });
                },
                onFinish: () => {
                    logger.info("Codex turn finished", { threadId, turnId });
                    if (!turnId) void messageMetadataStore.remove(messageId, threadId).catch((error) => logger.warn("Failed to remove unbound message metadata", { clientMessageId: messageId, error }));
                    session.clearTurnAttachments(clientId);
                    if (clientId) session.releaseClient(clientId);
                    session.setCodexState({ busy: false, threadId, turnId });
                    session.finishConversationRun(threadId);
                },
            });
            res.json({ ok: true, threadId });
        } catch (error) {
            await messageMetadataStore.remove(messageId, threadId).catch((metadataError) => logger.warn("Failed to remove rejected message metadata", { clientMessageId: messageId, error: metadataError }));
            session.releaseClient(clientId);
            session.setCodexState({ busy: false, threadId, turnId: "" });
            session.finishConversationRun(threadId);
            throw error;
        }
    }));

    /** 将 Codex 写操作串行化，避免多窗口在异步请求期间交叉修改会话。 */
    function codexMutation(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
        return route(async (req, res) => {
            if (!session.beginCodexMutation()) return res.status(409).json({ ok: false, code: "CONVERSATION_BUSY", error: "Codex 正在运行或正在切换会话，请稍后重试", state: session.conversationStateSnapshot });
            try {
                return await handler(req, res);
            } finally {
                session.endCodexMutation();
            }
        });
    }
    app.post("/agent/codex/approval", route(async (req, res) => {
        const decision = String(req.body?.decision || "");
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return res.status(400).json({ ok: false, error: "无效的审批决定" });
        const ok = await resolveCodexApproval(String(req.body?.requestId || ""), decision);
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "审批请求已失效" }) });
    }));
    app.post("/agent/codex/interrupt", route(async (req, res) => {
        const ok = await interruptCodexTurn(skillDraftRunning ? undefined : String(req.body?.threadId || ""));
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "当前没有可停止的任务" }) });
    }));
    app.post("/agent/claude/turn", (req, res) => {
        runClaudeTurn(String(req.body?.prompt || ""), emit);
        res.json({ ok: true });
    });
    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
        logger.error("HTTP request failed", { method: req.method, path: req.path, error });
        if (error instanceof SkillStoreError || error instanceof CodexSkillLookupError) return void res.status(error.statusCode).json({ ok: false, error: error.message });
        res.status(500).json({ ok: false, error: error.message });
    });

    app.listen(port, "127.0.0.1", () => {
        console.log("Infinite Canvas Agent");
        checkVersions();
        console.log(`Local URL: ${config.url}`);
        console.log(`Connect token: ${config.token}`);
        console.log("Codex MCP is not installed by this command.");
        console.log("Optional MCP add: codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent mcp");
        console.log("Remove manually added MCP: codex mcp remove infinite-canvas");
        if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
        logger.info("Canvas Agent started", { url: config.url, workspace: ensureSiteWorkspace(config).workspacePath, debugLog: logger.filePath });
        const activeThreadId = initialWorkspace.activeThreadId || "";
        if (activeThreadId && session.beginCodexMutation()) {
            void prepareExistingThread(activeThreadId).catch(async (error) => {
                if (!isRecoverableThreadError(error)) return failPreparedConversation(error, activeThreadId);
                session.beginConversation();
                setActiveThread("", { emptyThread: true, draftThread: true }, true);
                await prepareDraftThread("", "request");
            }).finally(() => session.endCodexMutation()).catch(() => undefined);
        }
    });
}

/** 将异步 Express 路由异常统一处理：主动返回带 CORS 头的 500 JSON，
 *  避免 Express 默认错误处理不带 Access-Control-Allow-Origin 头导致浏览器报跨域。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) =>
        void handler(req, res).catch((err: unknown) => {
            if (res.headersSent) return void next(err);
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[route] 未处理异常: ${message}`);
            try {
                res.status(500).json({ ok: false, error: message });
            } catch {
                next(err);
            }
        });
}

/** 从 Express 路由参数中读取单个字符串。 */
function routeParam(value: string | string[]) {
    return Array.isArray(value) ? value[0] || "" : value;
}

function permissionMode(value: unknown): AgentPermissionMode {
    return value === "automatic" || value === "full" ? value : "request";
}

function reasoningEffort(value: unknown): CodexReasoningEffort | undefined {
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : undefined;
}

function startupStatus(value: unknown): "starting" | "ready" | "failed" | "cancelled" {
    return value === "starting" || value === "ready" || value === "failed" ? value : "cancelled";
}

function mcpInventory(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const server = item as Record<string, unknown>;
        const name = String(server.name || "");
        return name ? [{ name, authStatus: String(server.authStatus || "") || undefined }] : [];
    });
}

/** 读取浏览器提交的 Skill 选择器；真实路径随后必须通过原生列表校验。 */
function skillSelector(value: unknown): CodexSkillSelector {
    const selector = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const name = typeof selector.name === "string" ? selector.name : "";
    const skillPath = typeof selector.path === "string" ? selector.path : "";
    if (!name || !skillPath) throw new CodexSkillLookupError("Skill 选择无效", 400);
    return { name, path: skillPath };
}

/** 使用当前操作系统的文件管理器定位本地文件。 */
function revealLocalFile(filePath: string, isDirectory: boolean) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const args = process.platform === "darwin"
        ? ["-R", filePath]
        : process.platform === "win32"
            ? [isDirectory ? filePath : `/select,${filePath}`]
            : [isDirectory ? filePath : path.dirname(filePath)];
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}

/** 结合服务配置解析当前请求 URL。 */
function requestUrl(req: Request, config: CanvasAgentConfig) {
    return new URL(req.originalUrl || req.url || "/", config.url);
}

/** 设置跨域响应头并记录通过 token 授权的来源。 */
function setCors(req: Request, res: Response, url: URL, config: CanvasAgentConfig) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (!origin || req.method === "OPTIONS" || url.pathname === "/health" || url.pathname === "/config") return true;
    config.origins ||= [];
    if (validToken(req, url, config.token) && !config.origins.includes(origin)) {
        config.origins.push(origin);
        saveConfig(config);
    }
    res.setHeader("Vary", "Origin");
    return config.origins.includes(origin);
}

/** 校验请求查询参数或请求头中的连接 token。 */
function validToken(req: Request, url: URL, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return url.searchParams.get("token") === token || header === token || (Array.isArray(header) && header.includes(token));
}

/** 向 Agent 提示词追加本轮图片附件引用说明。 */
function withAttachmentContext(prompt: string, attachments: Array<{ id: string; name: string }>) {
    if (!attachments.length) return prompt;
    const list = attachments.map((item, index) => `${index + 1}. attachmentId=${item.id}, name=${JSON.stringify(item.name)}`).join("\n");
    return `${prompt}\n\n本轮可用图片附件（顺序与图片输入一致）：\n${list}\n需要把附件放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes，再使用返回的画布节点 ID 创建生成流程。`;
}
