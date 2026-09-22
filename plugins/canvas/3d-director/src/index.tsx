// 3D 导演台节点:把「3D 导演台」(jlmlh-3d-director,MIT)以 iframe 嵌进画布。
// 静态产物托管在本站 /director-desk/,与画布同源,iframe 里那套宿主桥(hostBridge.ts)才能同源往返。
// 对接的两个方向:上游图片节点 → 送进导演台当全景背景;导演台截图 → 回传落成画布图片节点。
// 节点卡片不放 iframe:那套应用一加载就是 2MB JS + 一个 WebGL 场景,画布里多放几个会直接把页面拖垮,
// 因此和抠图工作台一致——卡片只做入口,真正的编辑器走全屏面板。
import { definePlugin, useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodePanelProps, CanvasAgentOp } from "@infinite-canvas/plugin-sdk";

// 导演台产物地址。插件包被宿主包成 blob: 模块执行,裸相对路径解析不了,必须带 origin。
const DESK_PATH = "/director-desk/index.html";

function deskUrl(theme: "dark" | "light") {
    const url = new URL(DESK_PATH, location.href);
    url.searchParams.set("theme", theme); // 先给主题,避免 iframe 打开时闪一下黑底
    return url.href;
}

// 画布主题 token → 导演台认的 dark/light。用背景色亮度判断,插件不必去读宿主的主题 store。
function deskTheme(ctx: CanvasNodeContext): "dark" | "light" {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(ctx.theme.canvas.background).trim());
    if (!match) return "dark";
    const value = parseInt(match[1], 16);
    const luma = (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255;
    return luma > 0.6 ? "light" : "dark";
}

// 上游第一个有内容的图片节点 = 导演台的全景背景;顺带带出连线 id,导演台里移除背景时按它回删连线。
function upstreamPanorama(ctx: CanvasNodeContext) {
    const image = ctx.getUpstream().find((node) => node.type === "image" && typeof node.metadata?.content === "string" && node.metadata.content);
    if (!image) return null;
    const edge = ctx.getConnections().find((item) => item.fromNodeId === image.id && item.toNodeId === ctx.node.id);
    return { sourceNodeId: image.id, edgeId: edge?.id ?? "", imageUrl: String(image.metadata!.content) };
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
        img.onerror = () => resolve({ width: 1, height: 1 });
        img.src = src;
    });
}

// 导演台发回截图 → 在本节点右侧按原始比例依次落成图片节点(不自动选中,免得抢走用户当前选择)。
async function dropCaptures(ctx: CanvasNodeContext, raw: unknown) {
    const items = Array.isArray(raw) ? raw : [];
    const ops: CanvasAgentOp[] = [];
    const x = ctx.node.position.x + ctx.node.width + 90;
    let y = ctx.node.position.y;
    for (let i = 0; i < items.length; i++) {
        const item = items[i] as { dataUrl?: unknown; fileName?: unknown } | null;
        const dataUrl = typeof item?.dataUrl === "string" ? item.dataUrl : "";
        if (!dataUrl) continue;
        const size = await imageSize(dataUrl);
        const width = 260;
        const height = Math.max(40, Math.round((width * size.height) / size.width));
        ops.push({
            type: "add_node",
            id: `director-shot-${Date.now()}-${i}`,
            nodeType: "image",
            title: typeof item?.fileName === "string" && item.fileName ? item.fileName.replace(/\.[^.]+$/, "") : `导演台截图 ${i + 1}`,
            x,
            y,
            width,
            height,
            metadata: { content: dataUrl, mimeType: "image/png", status: "success" },
        });
        y += height + 24;
    }
    if (ops.length) ctx.applyOps(ops);
}

// ---------------------------------------------------------------------------
// 面板:全屏 iframe + postMessage 桥。只在面板打开时挂监听,关掉即摘掉。
// ---------------------------------------------------------------------------
function DirectorPanel({ ctx, onClose }: CanvasNodePanelProps) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    // ctx 每次渲染都是新对象,进依赖会造成「渲染→新 ctx→effect 重跑」的循环,统一走 ref
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;
    const [handshaken, setHandshaken] = useState(false);

    const sendSession = useCallback(() => {
        const win = frameRef.current?.contentWindow;
        if (!win) return;
        const current = ctxRef.current;
        win.postMessage({ type: "storyai:director-desk-session", payload: { instanceId: `canvas-node:${current.node.id}`, theme: deskTheme(current) } }, window.location.origin);
        const panorama = upstreamPanorama(current);
        if (panorama) {
            win.postMessage({ type: "storyai:director-desk-panorama", payload: { ...panorama, fileName: "画布全景图.png" } }, window.location.origin);
        }
    }, []);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            // 只认本窗口里、本 iframe 发来的消息
            if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
            const type = (event.data as { type?: string } | null)?.type;
            if (type === "storyai:director-desk-ready") {
                sendSession();
                setHandshaken(true);
                return;
            }
            if (type === "storyai:director-desk-close") {
                onClose();
                return;
            }
            if (type === "storyai:director-desk-panorama-removed") {
                const edgeId = String((event.data as { payload?: { edgeId?: unknown } }).payload?.edgeId ?? "");
                if (edgeId) ctxRef.current.applyOps([{ type: "delete_connections", id: edgeId }]);
                return;
            }
            if (type === "storyai:director-desk-captures-sent") {
                void dropCaptures(ctxRef.current, (event.data as { payload?: { captures?: unknown } }).payload?.captures);
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [onClose, sendSession]);

    return (
        <div data-canvas-no-zoom onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.55)", display: "flex", flexDirection: "column", padding: 18, boxSizing: "border-box" }}>
            <div style={{ flex: "1 1 auto", minHeight: 0, position: "relative", borderRadius: 16, overflow: "hidden", border: `1px solid ${ctx.theme.toolbar.border}`, background: ctx.theme.canvas.background }}>
                <iframe
                    ref={frameRef}
                    title="3d-director-desk"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
                    src={deskUrl(deskTheme(ctx))}
                    style={{ width: "100%", height: "100%", border: 0, display: "block" }}
                />
                {handshaken ? null : <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", color: ctx.theme.node.placeholder, fontSize: 13 }}>正在加载 3D 导演台…</div>}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingTop: 10, color: ctx.theme.node.muted, fontSize: 12 }}>
                <span>上游图片会作为全景背景送进导演台;导演台里的截图会回传成本节点右侧的图片节点。</span>
                <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} style={{ padding: "7px 16px", borderRadius: 999, border: `1px solid ${ctx.theme.toolbar.border}`, background: "transparent", color: ctx.theme.node.text, cursor: "pointer", fontSize: 13 }}>关闭</button>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// 节点卡片:只做入口,顺带提示全景背景有没有接上。
// ---------------------------------------------------------------------------
function DirectorContent({ ctx }: CanvasNodeContentProps) {
    const hasPanorama = Boolean(upstreamPanorama(ctx));
    return (
        <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 12, boxSizing: "border-box", color: ctx.theme.node.text, textAlign: "center" }}>
            <div style={{ fontSize: 30 }}>🎬</div>
            <div style={{ fontSize: 13, color: ctx.theme.node.placeholder, lineHeight: 1.5 }}>{hasPanorama ? "已接入上游全景图 · 双击打开导演台" : "双击打开导演台（接一张图片节点可当全景背景）"}</div>
            <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => ctx.openPanel()} style={{ padding: "5px 14px", borderRadius: 8, border: "none", background: ctx.theme.toolbar.activeBg, color: ctx.theme.toolbar.activeText, cursor: "pointer", fontSize: 12 }}>打开导演台</button>
        </div>
    );
}

export default definePlugin({
    id: "3d-director",
    name: "3D 导演台",
    version: "0.1.0",
    description: "摆人物与机位、打关键帧运镜、按机位截图回画布,上游图片可作为全景背景",
    nodes: [
        {
            type: "3d-director:desk",
            title: "3D 导演台",
            icon: "🎬",
            description: "3D 分镜导演台(摆位 / 运镜 / 截图回画布)",
            defaultSize: { width: 320, height: 220 },
            defaultMetadata: {},
            minimapColor: "#8b5cf6",
            // 面板是全屏尺寸,必须 portal 到 body 才不被节点缩放/平移劫持
            fullscreenPanel: true,
            autoOpenPanel: false,
            onDoubleClick: (ctx) => { ctx.openPanel(); return true; },
            Content: DirectorContent,
            Panel: DirectorPanel,
            toolbar: (ctx) => [
                { id: "3d-director-open", title: "全屏打开 3D 导演台", label: "打开", icon: "🎬", onClick: () => ctx.openPanel() },
            ],
        },
    ],
});
