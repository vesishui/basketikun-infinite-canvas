import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

/** 请求日志：监控 API 类请求（尤其 POST），跳过静态资源，方法/状态码着色。 */
function requestLogger(): Plugin {
    const color = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
    const methodColor = (m: string) => (m === "POST" ? "36" : m === "PUT" || m === "PATCH" ? "33" : m === "DELETE" ? "35" : "90");
    const statusColor = (s: number) => (s >= 500 ? "31" : s >= 400 ? "33" : s >= 300 ? "36" : "32");
    const isStaticRequest = (url: string) =>
        url === "/" ||
        url.startsWith("/@") ||
        url.startsWith("/node_modules/") ||
        url.startsWith("/src/") ||
        /\.(js|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|txt)$/i.test(url);
    return {
        name: "request-logger",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const startedAt = Date.now();
                // 入口处先捕获原始 URL：vite 会把未知路径改写成 /index.html（SPA fallback）
                const originalUrl = (req as { originalUrl?: string }).originalUrl || req.url || "/";
                res.on("finish", () => {
                    if (req.method === "OPTIONS") return;
                    const method = (req.method || "GET").toUpperCase();
                    const url = originalUrl;
                    // 写方法全打；GET 只打 API 类路径，跳过静态资源，避免刷屏
                    if (method === "GET" && isStaticRequest(url)) return;
                    const ms = Date.now() - startedAt;
                    console.log(`  ${color("90", new Date().toLocaleTimeString("zh-CN", { hour12: false }))} ${color(methodColor(method), method.padEnd(6))} ${url} ${color(statusColor(res.statusCode), String(res.statusCode))} ${color("90", ms + "ms")}`);
                });
                next();
            });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), requestLogger()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
