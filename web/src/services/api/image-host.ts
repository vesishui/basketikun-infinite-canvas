/**
 * 免费图床上传：把 base64 dataURL 图片上传到公网可访问的图床，返回 HTTPS URL。
 * 顺序：kingimage（国内直连，偶发 500，自动重试）→ litterbox（72h 短链）。
 * 注意：temp.sh 已移除 —— 实测土豆(ai-tudou)上游服务器无法从 temp.sh 下载图片，
 *       会导致视频任务报 502「视频参考图下载或落盘失败: context deadline exceeded」。
 * 全部走 canvas-agent relay 中转（浏览器直连图床会被 CORS 拦截）。
 * 参考：Python 版 Infinite-Canvas main.py 的 upload_local_video_to_cloud 实现。
 */
import { relayOpenAiRequest } from "./relay";

/** 图床上传 URL 缓存（hash → 公网 URL）：同内容图片不再重复上传，图生图/视频/音频脚本通用。 */
const UPLOAD_CACHE_KEY = "public-upload-url-cache-v1";
const UPLOAD_CACHE_MAX = 500;

function readUploadCache(): Record<string, string> {
    try {
        const parsed = JSON.parse(localStorage.getItem(UPLOAD_CACHE_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeUploadCache(cache: Record<string, string>) {
    try {
        const entries = Object.entries(cache).slice(-UPLOAD_CACHE_MAX);
        localStorage.setItem(UPLOAD_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
        // localStorage 不可用时忽略，退化为正常上传
    }
}

/** 计算 dataURL 的 SHA-256，作为图床 URL 缓存 key（同内容图片 hash 相同）。 */
async function dataUrlHash(dataUrl: string): Promise<string> {
    try {
        const bytes = await fetch(dataUrl).then((res) => res.arrayBuffer());
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
        return "";
    }
}

/** 用 HEAD 经 canvas-agent relay 验证公网 URL 仍可访问（浏览器直连图床会被 CORS 拦）。 */
async function isPublicUrlAlive(url: string, signal?: AbortSignal): Promise<boolean> {
    try {
        await relayOpenAiRequest({ baseUrl: "", apiKey: "", method: "HEAD", path: url, kind: "json", signal });
        return true;
    } catch {
        return false;
    }
}

/** 图床上传配置 */
type HostConfig = {
    name: string;
    url: string;
    fileField: string;
    fields: Record<string, string>;
    /** 从响应中提取图片直链 */
    extractUrl: (response: unknown) => string | null;
};

/** 可用图床（temp.sh 已排除：土豆上游无法下载其图片） */
const HOSTS: HostConfig[] = [
    {
        name: "kingimage",
        url: "https://file.kxlove.top/api.php",
        fileField: "file",
        fields: { show: "0", ispwd: "0" },
        extractUrl: (resp: unknown) => {
            const obj = resp as Record<string, unknown> | null;
            if (obj?.code !== 0 && obj?.code !== "0") return null;
            const raw = obj?.downurl;
            if (typeof raw !== "string" || !raw.startsWith("http")) return null;
            // down.php 返回 application/force-download（attachment），上游服务器（如 yunfei/土豆）
            // 按 Content-Type 判断会认为"不是图片"而报 images[0] is not an image。
            // view.php 返回 image/*（inline），是可直接被当作图片的直链。
            return raw.replace(/\/down\.php\//, "/view.php/");
        },
    },
    {
        name: "litterbox",
        url: "https://litterbox.catbox.moe/resources/internals/api.php",
        fileField: "fileToUpload",
        fields: { reqtype: "fileupload", time: "72h" },
        extractUrl: (resp: unknown) => {
            const text = typeof resp === "string" ? resp : "";
            const url = text.split("\n")[0]?.trim() || "";
            return url.startsWith("http") ? url : null;
        },
    },
];

/**
 * 把 dataURL 图片上传到免费图床，返回公网 HTTPS URL。
 * @param dataUrl base64 dataURL 或 http(s) URL（已经是公网 URL 则原样返回）
 * @param signal 可选的取消信号
 * @throws 如果所有图床都失败
 */
export async function uploadImageToPublicUrl(dataUrl: string, signal?: AbortSignal): Promise<string> {
    const t0 = performance.now();
    // 已经是公网 URL → 透传
    if (dataUrl.startsWith("http://") || dataUrl.startsWith("https://")) {
        console.log(`[图床] ${dataUrl.slice(0, 60)} 已是公网 URL，透传 (${Math.round(performance.now() - t0)}ms)`);
        return dataUrl;
    }
    if (!dataUrl.startsWith("data:")) throw new Error(`不支持上传非 dataURL 资源: ${dataUrl.slice(0, 60)}`);

    // 本地缓存命中：同内容图片之前已上传过图床，HEAD 验证 URL 仍有效则直接复用，避免重复上传
    const hash = await dataUrlHash(dataUrl);
    if (hash) {
        const cached = readUploadCache()[hash];
        if (cached) {
            const alive = await isPublicUrlAlive(cached, signal);
            console.log(`[图床] 缓存命中 ${hash.slice(0, 8)} → ${cached} 存活=${alive} (${Math.round(performance.now() - t0)}ms)`);
            if (alive) return cached;
        }
    }

    const errors: string[] = [];
    for (const host of HOSTS) {
        // kingimage 偶发 500，重试一次再轮到 litterbox
        const attempts = host.name === "kingimage" ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const t1 = performance.now();
            try {
                const response = await relayOpenAiRequest({
                    baseUrl: "",
                    apiKey: "",
                    method: "POST",
                    path: host.url,
                    kind: "form",
                    body: {
                        fields: host.fields,
                        files: [
                            { name: host.fileField, filename: "image.png", dataUrl },
                        ],
                    },
                    signal,
                });
                const url = host.extractUrl(response);
                if (url) {
                    console.log(`[图床] 上传成功 ${host.name} → ${url} 尝试${attempt + 1} (${Math.round(performance.now() - t1)}ms)`);
                    // 上传成功：写缓存，下次同内容图片直接复用
                    if (hash) {
                        const cache = readUploadCache();
                        cache[hash] = url;
                        writeUploadCache(cache);
                    }
                    console.log(`[图床] 总耗时 ${Math.round(performance.now() - t0)}ms`);
                    return url;
                }
                errors.push(`${host.name}: 响应中没有提取到有效 URL`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[图床] ${host.name} 第${attempt + 1}次失败 (${Math.round(performance.now() - t1)}ms): ${message}`);
                errors.push(`${host.name}: ${message}`);
            }
        }
    }
    throw new Error(`所有免费图床上传失败：${errors.join("；")}`);
}