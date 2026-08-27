#!/usr/bin/env node
/**
 * 通用 CORS 转发代理（零依赖，Node 内置模块）
 * 解决前端直连外部 API 被浏览器跨域策略拦截的问题，不改前端代码。
 *
 * 启动示例：
 *   PORT=8787 \
 *   DEFAULT_TARGET=https://api.example.com \
 *   PROXY_ROUTES="xinfeng=https://xinfeng.best;gemini=https://generativelanguage.googleapis.com" \
 *   node server.mjs
 *
 * 前端配置面板 Base URL 填：
 *   http://127.0.0.1:8787          → 走 DEFAULT_TARGET（OpenAI 兼容会自动拼 /v1）
 *   http://127.0.0.1:8787/xinfeng  → 走 PROXY_ROUTES 中 xinfeng 对应目标
 *   转发规则：剥掉路径开头的 /<prefix>，剩余路径原样拼到目标地址（含 query）。
 */
import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.PORT) || 8787;
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || "").replace(/\/+$/, "");
const ROUTES = new Map();
for (const item of (process.env.PROXY_ROUTES || "").split(";").filter(Boolean)) {
    const idx = item.indexOf("=");
    if (idx > 0) {
        ROUTES.set(item.slice(0, idx).trim().replace(/^\/+|\/+$/g, ""), item.slice(idx + 1).trim().replace(/\/+$/, ""));
    }
}

const color = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const methodColor = (m) => (m === "POST" ? "36" : m === "PUT" || m === "PATCH" ? "33" : m === "DELETE" ? "35" : "90");
const statusColor = (s) => (s >= 500 ? "31" : s >= 400 ? "33" : s >= 300 ? "36" : "32");

/** 根据路径前缀解析转发目标；无匹配前缀时用默认目标。 */
function resolveTarget(rawUrl) {
    const qIdx = rawUrl.indexOf("?");
    const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const query = qIdx >= 0 ? rawUrl.slice(qIdx) : "";
    const seg = path.split("/").filter(Boolean)[0] || "";
    if (seg && ROUTES.has(seg)) return ROUTES.get(seg) + path.slice(seg.length + 1) + query;
    if (DEFAULT_TARGET) return DEFAULT_TARGET + path + query;
    return null;
}

function log(method, path, target, status, startedAt, note = "") {
    const ms = Date.now() - startedAt;
    const noteText = note ? color("31", " " + note) : "";
    console.log(`  ${color("90", new Date().toLocaleTimeString("zh-CN", { hour12: false }))} ${color(methodColor(method), method.padEnd(6))} ${path} ${color("90", "→")} ${target} ${color(statusColor(status), String(status))} ${color("90", ms + "ms")}${noteText}`);
}

const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const method = (req.method || "GET").toUpperCase();
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Content-Type, Authorization, x-goog-api-key",
        "Access-Control-Expose-Headers": "*",
        "Vary": "Origin",
    };

    // 预检请求直接应答
    if (method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        log(method, req.url, "预检", 204, startedAt);
        return;
    }

    const target = resolveTarget(req.url || "/");
    if (!target) {
        res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
        res.end("CORS proxy: no route configured. Set DEFAULT_TARGET or PROXY_ROUTES.");
        log(method, req.url, "未匹配路由", 502, startedAt);
        return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
        res.end("CORS proxy: invalid target URL: " + target);
        log(method, req.url, target, 502, startedAt);
        return;
    }

    const transport = targetUrl.protocol === "https:" ? https : http;
    const headers = { ...req.headers, host: targetUrl.host };
    delete headers["origin"]; // 去掉浏览器 Origin，避免上游 CSRF/同源校验干扰

    const proxyReq = transport.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, { ...proxyRes.headers, ...corsHeaders });
        proxyRes.pipe(res); // 流式透传，支持 SSE / 大文件
        log(method, req.url, `${targetUrl.origin}${targetUrl.pathname}`, proxyRes.statusCode || 502, startedAt);
    });
    proxyReq.on("error", (err) => {
        res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
        res.end("CORS proxy: upstream error: " + err.message);
        log(method, req.url, targetUrl.href, 502, startedAt, err.message);
    });
    req.on("error", () => proxyReq.destroy());
    req.pipe(proxyReq); // 流式透传 body（支持 30MB 图片上传）
});

server.requestTimeout = 0; // AI 请求可能长达数分钟，不做超时限制
server.headersTimeout = 0;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`CORS 转发代理已启动:`);
    console.log(`  Local:   http://127.0.0.1:${PORT}`);
    console.log(`  默认目标: ${DEFAULT_TARGET || "(未设置)"}`);
    console.log(`  路由表:   ${[...ROUTES.entries()].map(([k, v]) => `${k} → ${v}`).join(", ") || "(未设置)"}`);
    console.log(`  前端 Base URL 填 http://127.0.0.1:${PORT} 或 http://127.0.0.1:${PORT}/<prefix>`);
});
