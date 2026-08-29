// 脚本生成器插件 —— 批量生成弹窗(分镜批量生图 / 批量生视频)
// 本期纯 mock:所有按钮只弹 toast,不发任何请求。
import { useMemo, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasTheme } from "@infinite-canvas/plugin-sdk";

import { IMAGE_MODELS, QUALITY_OPTIONS, RATIO_OPTIONS, RESOLUTION_OPTIONS, VIDEO_MODELS } from "./mock";
import type { Shot } from "./types";
import { Select, btn, primaryBtn, stop, useT, type ToastApi } from "./ui";

export type BatchMode = "image" | "video";

type BatchModalProps = {
    mode: BatchMode;
    theme: CanvasTheme;
    shots: Shot[];
    onClose: () => void;
    toast: ToastApi;
};

export function BatchModal({ mode, theme, shots, onClose, toast }: BatchModalProps) {
    const t = useT(theme);
    const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(shots.map((s) => [s.id, true])));
    // 批量生视频:每镜秒数(4-30,默认5)
    const [seconds, setSeconds] = useState<Record<string, number>>(() => Object.fromEntries(shots.map((s) => [s.id, 5])));
    const [model, setModel] = useState(mode === "image" ? IMAGE_MODELS[0] : VIDEO_MODELS[0]);
    const [quality, setQuality] = useState(QUALITY_OPTIONS[0]);
    const [resolution, setResolution] = useState(RESOLUTION_OPTIONS[1]);
    const [ratio, setRatio] = useState(RATIO_OPTIONS[0]);

    const selected = useMemo(() => shots.filter((s) => checked[s.id]), [shots, checked]);
    const toggle = (id: string) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));

    const changeSeconds = (id: string, delta: number) => {
        setSeconds((prev) => ({ ...prev, [id]: Math.max(4, Math.min(30, (prev[id] || 5) + delta)) }));
    };

    const confirm = () => {
        toast.show(mode === "image" ? `已创建生成器组(${selected.length})(mock),未发请求` : `已创建视频生成器组(${selected.length})(mock),未发请求`);
        onClose();
    };

    return (
        <div data-canvas-no-zoom style={{ position: "fixed", inset: 0, zIndex: 400, display: "grid", placeItems: "center", background: "rgba(0,0,0,.45)" }} onMouseDown={stop}>
            <div onMouseDown={stop} style={{ width: 620, maxWidth: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column", borderRadius: 16, border: `1px solid ${t.border}`, background: t.panel, boxShadow: "0 24px 64px rgba(0,0,0,.35)", overflow: "hidden" }}>
                {/* 标题 */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{mode === "image" ? "🖼 分镜批量生图" : "🎬 分镜批量生视频"}</span>
                    <button type="button" title="关闭" onMouseDown={stop} onClick={onClose} style={{ ...btn(t, { width: 28, height: 28, padding: 0, borderRadius: "50%" }) }}>✕</button>
                </div>

                {/* 说明条 */}
                <div style={{ margin: 12, padding: "8px 14px", borderRadius: 10, background: "rgba(6,182,212,.12)", border: "1px solid rgba(6,182,212,.35)", fontSize: 12, color: "#0e7490", flexShrink: 0 }}>
                    {mode === "image" ? "会优先使用已生成的角色、场景和道具参考图" : "会使用已生成的参考图,并按每镜时长生成视频片段"}
                </div>

                {/* 镜头复选列表 */}
                <div style={{ flex: 1, overflow: "auto", padding: "0 12px" }}>
                    {shots.map((shot) => (
                        <div key={shot.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", borderBottom: `1px solid ${t.border}` }}>
                            <button
                                type="button"
                                onMouseDown={stop}
                                onClick={() => toggle(shot.id)}
                                style={{
                                    width: 16,
                                    height: 16,
                                    borderRadius: 5,
                                    border: `1px solid ${checked[shot.id] ? "#06b6d4" : t.border}`,
                                    background: checked[shot.id] ? "#06b6d4" : "transparent",
                                    display: "grid",
                                    placeItems: "center",
                                    color: "#fff",
                                    fontSize: 10,
                                    cursor: "pointer",
                                    padding: 0,
                                    flexShrink: 0,
                                }}
                            >
                                {checked[shot.id] ? "✓" : ""}
                            </button>
                            <span style={{ fontSize: 12, fontWeight: 700, color: t.text, width: 26, flexShrink: 0 }}>{String(shot.number).padStart(2, "0")}</span>
                            <span style={{ flex: 1, fontSize: 12, color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shot.description}</span>
                            <span style={{ fontSize: 11, color: t.muted, flexShrink: 0 }}>{shot.shotSize}</span>
                            {mode === "video" ? (
                                <span style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }} onMouseDown={stop} onPointerDown={stop}>
                                    <button type="button" title="减少秒数" onClick={() => changeSeconds(shot.id, -1)} style={{ ...btn(t, { width: 22, height: 22, padding: 0, borderRadius: 6 }) }}>−</button>
                                    <input
                                        type="number"
                                        min={4}
                                        max={30}
                                        value={seconds[shot.id] ?? 5}
                                        onChange={(e) => setSeconds((prev) => ({ ...prev, [shot.id]: Math.max(4, Math.min(30, Number(e.target.value) || 5)) }))}
                                        style={{ width: 44, textAlign: "center", ...(t.border ? { border: `1px solid ${t.border}`, background: t.bg, color: t.text, borderRadius: 6, height: 22, fontSize: 12, outline: "none" } : {}) }}
                                        onMouseDown={stop}
                                        onPointerDown={stop}
                                    />
                                    <button type="button" title="增加秒数" onClick={() => changeSeconds(shot.id, 1)} style={{ ...btn(t, { width: 22, height: 22, padding: 0, borderRadius: 6 }) }}>+</button>
                                    <span style={{ fontSize: 10, color: t.muted }}>s</span>
                                </span>
                            ) : null}
                        </div>
                    ))}
                </div>

                {/* 底部:已选计数 + 下拉 + 确认 */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: `1px solid ${t.border}`, background: t.panel, flexShrink: 0, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: t.text, marginRight: 2 }}>已选 {selected.length}</span>
                    <Select t={t} value={model} options={mode === "image" ? IMAGE_MODELS : VIDEO_MODELS} onChange={setModel} title="模型" />
                    <Select t={t} value={quality} options={QUALITY_OPTIONS} onChange={setQuality} title="画质" />
                    <Select t={t} value={resolution} options={RESOLUTION_OPTIONS} onChange={setResolution} title="分辨率" />
                    <Select t={t} value={ratio} options={RATIO_OPTIONS} onChange={setRatio} title="宽高比" />
                    <span style={{ flex: 1 }} />
                    <button type="button" onMouseDown={stop} onClick={confirm} style={primaryBtn(t)}>
                        确认并创建生成器组({selected.length})
                    </button>
                </div>
            </div>
        </div>
    );
}
