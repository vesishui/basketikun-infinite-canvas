import axios from "axios";

import { useAgentStore } from "@/stores/use-agent-store";
import { buildApiUrl } from "@/stores/use-config-store";

export type RelayKind = "json" | "form" | "blob";

export type RelayOpenAiOptions = {
    baseUrl: string;
    apiKey: string;
    method?: string;
    path: string;
    body?: unknown;
    kind?: RelayKind;
    /** 额外请求头透传给上游（如 x-goog-api-key 等） */
    headers?: Record<string, string>;
    signal?: AbortSignal;
};

/**
 * OpenAI 兼容接口中转：优先走本地 canvas-agent 的 /agent/direct/relay，
 * 避免浏览器直连第三方 API 被 CORS 拦截（图片生成/编辑、视频创建/查询/下载、音频等）。
 * 未连接 agent 时回退为浏览器直连（可能被 CORS 拦，保持原有行为）。
 */
export async function relayOpenAiRequest(options: RelayOpenAiOptions): Promise<unknown> {
    const { url, token } = useAgentStore.getState();
    const endpoint = url?.trim().replace(/\/+$/, "");
    if (endpoint && token) {
        // validateStatus 恒为 true：relay 非 2xx 时也先拿响应体，把真实错误详情抛给调用方（否则 axios 只报 "Network Error"）
        // 429 限流：上游临时限流时自动重试（带指数退避），避免一次限流直接失败
        const MAX_RETRY = 2;
        for (let attempt = 0; ; attempt += 1) {
            const response = await axios.post(
                `${endpoint}/agent/direct/relay?token=${encodeURIComponent(token)}`,
                {
                    baseUrl: options.baseUrl,
                    apiKey: options.apiKey,
                    method: options.method || "POST",
                    path: options.path,
                    body: options.kind === "blob" ? undefined : options.body,
                    kind: options.kind || "json",
                    headers: options.headers || {},
                },
                { signal: options.signal, validateStatus: () => true },
            );
            const data = response.data as { ok?: boolean; data?: string; contentType?: string; error?: string };
            if (data && data.ok === false && response.status === 429 && attempt < MAX_RETRY && !options.signal?.aborted) {
                // 上游限流，等待后重试（retry-after 若提供则用之，否则递增退避）
                const retryAfter = Number(response.headers?.["retry-after"]) || 2000 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, retryAfter));
                continue;
            }
            if (data && data.ok === false) {
                throw new Error(data.error || `中继请求失败 (HTTP ${response.status})`);
            }
            if (options.kind === "blob") {
                if (!data?.ok || !data.data) throw new Error(data?.error || "中继失败");
                const binary = atob(data.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return new Blob([bytes], { type: data.contentType || "application/octet-stream" });
            }
            return data;
        }
    }
    // 直连回退（无 agent 时，可能被 CORS 拦截）
    const target = /^https?:\/\//i.test(options.path) ? options.path : buildApiUrl(options.baseUrl, options.path);
    const headers: Record<string, string> = { ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...(options.headers || {}) };
    if (options.kind !== "form" && !headers["content-type"]) headers["content-type"] = "application/json";
    const response = await axios.request({
        method: options.method || "POST",
        url: target,
        headers,
        data: options.body,
        responseType: options.kind === "blob" ? "blob" : undefined,
        signal: options.signal,
    });
    return response.data;
}
