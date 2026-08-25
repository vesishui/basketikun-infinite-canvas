import axios from "axios";

import { useAgentStore } from "@/stores/use-agent-store";
import { buildApiUrl } from "@/stores/use-config-store";

export type RelayKind = "json" | "form" | "blob";

export type RelayOpenAiOptions = {
    baseUrl: string;
    apiKey: string;
    method?: "GET" | "POST";
    path: string;
    body?: unknown;
    kind?: RelayKind;
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
        const response = await axios.post(
            `${endpoint}/agent/direct/relay?token=${encodeURIComponent(token)}`,
            {
                baseUrl: options.baseUrl,
                apiKey: options.apiKey,
                method: options.method || "POST",
                path: options.path,
                body: options.kind === "blob" ? undefined : options.body,
                kind: options.kind || "json",
            },
            { signal: options.signal },
        );
        if (options.kind === "blob") {
            const payload = response.data as { ok?: boolean; data?: string; contentType?: string; error?: string };
            if (!payload?.ok || !payload.data) throw new Error(payload?.error || "中继失败");
            const binary = atob(payload.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], { type: payload.contentType || "application/octet-stream" });
        }
        return response.data;
    }
    // 直连回退（无 agent 时，可能被 CORS 拦截）
    const target = buildApiUrl(options.baseUrl, options.path);
    const headers: Record<string, string> = options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {};
    if (options.kind !== "form") headers["content-type"] = "application/json";
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
