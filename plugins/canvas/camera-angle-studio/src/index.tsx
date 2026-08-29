// 镜头视角标注台节点插件:
// 节点三态: empty → ready → generated
// 双击/按钮进入全屏标注台,在画布上拖拽箭头实时调整视角参数,
// 右侧提示词文本域实时联动,新视角生成(mock)后结果流展示。
import { definePlugin, useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodePanelProps } from "@infinite-canvas/plugin-sdk";

import { Studio } from "./studio";
import type { StudioMeta } from "./types";
import { EMPTY_META } from "./types";

const RED = "#e63c3c";
const RED_BG = "rgba(230,60,60,.14)";
const RED_BORDER = "rgba(230,60,60,.45)";

function readMeta(node: CanvasNodeContext["node"]): StudioMeta {
    const m = node.metadata ?? {};
    return {
        stage: (m.stage as StudioMeta["stage"]) || "empty",
        image: m.image as string | undefined,
        settings: (m.settings as StudioMeta["settings"]) || EMPTY_META.settings,
        generated: Boolean(m.generated),
    };
}

function Content({ ctx }: CanvasNodeContentProps) {
    const meta = readMeta(ctx.node);
    const fileRef = useRef<HTMLInputElement>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const noticeTimer = useRef<number | null>(null);

    const update = useCallback((patch: Partial<StudioMeta>) => ctx.updateMetadata(patch as unknown as Record<string, unknown>), [ctx]);

    const showNotice = (text: string) => {
        setNotice(text);
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(null), 2000);
    };

    const openStudio = () => {
        ctx.updateMetadata({ panelMode: "studio" } as unknown as Record<string, unknown>);
        ctx.openPanel();
    };

    const handleUpload = (file: File | undefined) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => update({ image: String(reader.result || ""), stage: "ready" });
        reader.readAsDataURL(file);
    };

    // 双击打开(仅 ready/generated)
    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (meta.stage !== "empty") openStudio();
    };

    const btn = {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 28,
        padding: "0 12px",
        borderRadius: 8,
        border: `1px solid ${RED_BORDER}`,
        background: RED_BG,
        color: RED,
        fontSize: 12,
        cursor: "pointer",
        userSelect: "none" as const,
        whiteSpace: "nowrap" as const,
    };

    return (
        <div
            data-canvas-no-zoom
            onDoubleClick={handleDoubleClick}
            style={{
                position: "relative",
                height: "100%",
                width: "100%",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                boxSizing: "border-box",
                background: meta.image ? "transparent" : "#0d0d0f",
                borderRadius: 16,
                color: "#eee",
            }}
        >
            {/* 场景图 */}
            {meta.image ? (
                <img src={meta.image} alt="场景" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", borderRadius: 16, pointerEvents: "none" }} />
            ) : null}

            {/* empty:虚线框上传入口 */}
            {meta.stage === "empty" ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20, border: "2px dashed rgba(255,255,255,.2)", borderRadius: 16, margin: 10 }}>
                    <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleUpload(e.target.files?.[0])} />
                    <span style={{ fontSize: 28, opacity: 0.4 }}>🎬</span>
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,.5)", textAlign: "center" }}>点击上传场景图</span>
                    <button type="button" onClick={() => fileRef.current?.click()} style={btn}>
                        选择图片
                    </button>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,.3)", textAlign: "center" }}>支持 JPG/PNG,仅本地读取</span>
                </div>
            ) : null}

            {/* ready/generated:操作按钮 */}
            {meta.stage === "ready" || meta.stage === "generated" ? (
                <div style={{ position: "absolute", bottom: 10, left: 10, right: 10, display: "flex", flexDirection: "column", gap: 6, zIndex: 10 }}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); openStudio(); }} style={{ ...btn, height: 32, fontSize: 13, background: RED, color: "#fff", border: "none" }}>
                        打开标注台 →
                    </button>
                    {meta.stage === "generated" ? (
                        <div style={{ display: "flex", gap: 6 }}>
                            {[0, 1, 2].map((i) => (
                                <div
                                    key={i}
                                    style={{
                                        flex: 1,
                                        height: 40,
                                        borderRadius: 8,
                                        background: "linear-gradient(135deg,#2a1a1a,#1a1a2a)",
                                        border: `1px solid ${RED_BORDER}`,
                                        display: "grid",
                                        placeItems: "center",
                                        fontSize: 10,
                                        color: RED,
                                        pointerEvents: "none",
                                    }}
                                >
                                    新视角 {i + 1}
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {/* 顶部态标识 */}
            <div style={{ position: "absolute", top: 8, left: 10, fontSize: 10, color: "rgba(255,255,255,.4)", pointerEvents: "none" }}>
                {meta.stage === "empty" ? "📷 未上传场景图" : "🎬 镜头视角标注台"}
            </div>

            {/* 内联提示 */}
            {notice ? (
                <div style={{ position: "absolute", left: 10, right: 10, bottom: 48, padding: "6px 12px", borderRadius: 8, background: RED_BG, border: `1px solid ${RED_BORDER}`, color: RED, fontSize: 11, textAlign: "center", zIndex: 20 }}>
                    {notice}
                </div>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 全屏 Panel:渲染标注台
// ---------------------------------------------------------------------------
function StudioPanel({ ctx, onClose }: CanvasNodePanelProps) {
    const meta = readMeta(ctx.node);
    const update = useCallback((patch: Partial<StudioMeta>) => ctx.updateMetadata(patch as unknown as Record<string, unknown>), [ctx]);
    const [toastMsg, setToastMsg] = useState<string | null>(null);
    const toastTimer = useRef<number | null>(null);

    const toast = {
        show: (msg: string) => {
            setToastMsg(msg);
            if (toastTimer.current) window.clearTimeout(toastTimer.current);
            toastTimer.current = window.setTimeout(() => setToastMsg(null), 2600);
        },
    };

    useEffect(() => () => {
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
    }, []);

    const handleClose = () => {
        // 如果生成过新视角,节点变 generated
        const current = readMeta(ctx.node);
        if (current.generated) {
            ctx.updateMetadata({ stage: "generated" as StudioMeta["stage"], panelMode: undefined });
        } else {
            ctx.updateMetadata({ panelMode: undefined });
        }
        onClose();
    };

    if (!meta.image) {
        // 没有场景图时直接关闭
        ctx.updateMetadata({ panelMode: undefined });
        onClose();
        return null;
    }

    return (
        <>
            <Studio
                ctx={ctx}
                meta={meta}
                onChange={update}
                onClose={handleClose}
                toast={toast}
            />
            {toastMsg ? (
                <div
                    style={{
                        position: "fixed",
                        left: "50%",
                        bottom: 48,
                        transform: "translateX(-50%)",
                        zIndex: 5000,
                        padding: "9px 18px",
                        borderRadius: 999,
                        background: "rgba(0,0,0,.88)",
                        border: "1px solid rgba(230,60,60,.5)",
                        color: "#e63c3c",
                        fontSize: 13,
                        boxShadow: "0 8px 30px rgba(0,0,0,.5)",
                        pointerEvents: "none",
                    }}
                >
                    {toastMsg}
                </div>
            ) : null}
        </>
    );
}

export default definePlugin({
    id: "camera-angle-studio",
    name: "镜头视角标注台",
    version: "1.0.0",
    description: "在场景图上拖拽箭头标注新视角,实时联动焦段/光圈/俯仰参数,生成新视角画面(mock)",
    nodes: [
        {
            type: "camera-angle-studio:board",
            title: "镜头视角标注台",
            icon: "🎬",
            description: "标注镜头视角 → 生成新视角画面",
            defaultSize: { width: 280, height: 240 },
            defaultMetadata: { stage: "empty" },
            minimapColor: "#e63c3c",
            resource: (node) => ({ kind: "text", text: "镜头视角标注台" }),
            Content,
            // 全屏 Panel(视口级 fixed 容器,不受画布缩放影响)
            fullscreenPanel: true,
            Panel: StudioPanel,
        },
    ],
});