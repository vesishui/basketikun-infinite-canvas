/**
 * 免费图床上传：把 base64 dataURL 图片上传到公网可访问的图床，返回 HTTPS URL。
 * 顺序：kingimage（国内直连，偶发 500，自动重试）→ litterbox（72h 短链）。
 * 注意：temp.sh 已移除 —— 实测土豆(ai-tudou)上游服务器无法从 temp.sh 下载图片，
 *       会导致视频任务报 502「视频参考图下载或落盘失败: context deadline exceeded」。
 * 全部走 canvas-agent relay 中转（浏览器直连图床会被 CORS 拦截）。
 * 参考：Python 版 Infinite-Canvas main.py 的 upload_local_video_to_cloud 实现。
 */
import { relayOpenAiRequest } from "./relay";

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
    // 已经是公网 URL → 透传
    if (dataUrl.startsWith("http://") || dataUrl.startsWith("https://")) return dataUrl;
    if (!dataUrl.startsWith("data:")) throw new Error(`不支持上传非 dataURL 资源: ${dataUrl.slice(0, 60)}`);

    const errors: string[] = [];
    for (const host of HOSTS) {
        // kingimage 偶发 500，重试一次再轮到 litterbox
        const attempts = host.name === "kingimage" ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
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
                if (url) return url;
                errors.push(`${host.name}: 响应中没有提取到有效 URL`);
            } catch (error) {
                errors.push(`${host.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    throw new Error(`所有免费图床上传失败：${errors.join("；")}`);
}