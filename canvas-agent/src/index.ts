#!/usr/bin/env node
import { setGlobalDispatcher, ProxyAgent } from "undici";

// Node.js 原生 fetch() 不自动使用 HTTP_PROXY/HTTPS_PROXY 环境变量，
// 需要手动设置全局 dispatcher，否则 agent 转发请求到 Google API 等被墙地址会 "fetch failed"。
const proxyUrl =
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[proxy] Using proxy: ${proxyUrl}`);
} else {
    console.log("[proxy] No HTTP_PROXY/HTTPS_PROXY env var found, fetch() will connect directly.");
}

import { startHttpServer } from "./server/http.js";
import { startMcpServer } from "./server/mcp.js";

if (process.argv[2] === "mcp") await startMcpServer();
else startHttpServer();
