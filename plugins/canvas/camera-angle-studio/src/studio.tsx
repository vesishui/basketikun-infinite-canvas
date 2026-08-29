// 镜头视角标注台 —— 全屏标注台组件
// 画布交互(箭头拖拽/滚轮/右键) + 顶部参数胶囊 + 右侧面板(规则/提示词/设置) + 底部结果流
// 所有与箭头相关的 UI 实时同步,不滞后。
import { useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

import { APERTURES, autoPromptFromArrow, deriveArrow, formatAperture, apertureStep } from "./format";
import type { Arrow, StudioMeta, StudioSettings } from "./types";

type StudioProps = {
    ctx: CanvasNodeContext;
    meta: StudioMeta;
    onChange: (patch: Partial<StudioMeta>) => void;
    onClose: () => void;
    toast: { show: (msg: string) => void };
};

// 初始箭头(默认朝右上方 45°)
function defaultArrow(w: number, h: number): Arrow {
    return {
        x0: w * 0.38,
        y0: h * 0.62,
        x1: w * 0.62,
        y1: h * 0.38,
        strokeWidth: 8,
        depthOut: false,
    };
}

// 主色
const RED = "#e63c3c";
const RED_BG = "rgba(230,60,60,.14)";
const RED_BORDER = "rgba(230,60,60,.45)";
const DARK = "#0d0d0f";
const DARK_PANEL = "#141416";
const DARK_INPUT = "#0a0a0c";

export function Studio({ ctx, meta, onChange, onClose, toast }: StudioProps) {
    const areaRef = useRef<HTMLDivElement>(null);
    const [areaSize, setAreaSize] = useState({ w: 600, h: 400 });
    const [arrow, setArrow] = useState<Arrow>(() => defaultArrow(600, 400));
    const dragRef = useRef<{
        started: boolean;
        x0: number;
        y0: number;
        depthOut: boolean;
        pointerId: number;
    } | null>(null);

    // 提示词文本域:联动模式(autoMode = true 时拖动箭头自动覆盖)
    const [promptText, setPromptText] = useState("");
    const [autoMode, setAutoMode] = useState(true);
    const promptRef = useRef<HTMLTextAreaElement>(null);

    // 生成设置
    const [settings, setSettings] = useState<StudioSettings>(meta.settings || { resolution: "2K", quality: "高质量", ratio: "16:9", customRatio: "2.35" });
    const [ratioCustom, setRatioCustom] = useState(settings.customRatio || "2.35");

    // 结果流:生成后 mock 占位
    const [generated, setGenerated] = useState(false);

    // 箭头变动时:更新自动提示词(若 autoMode 开启)
    const syncAutoPrompt = useCallback(
        (a: Arrow) => {
            if (!autoMode) return;
            const text = autoPromptFromArrow(a, areaSize.w, areaSize.h);
            setPromptText(text);
        },
        [autoMode, areaSize.w, areaSize.h],
    );

    // 更新箭头 + 同步提示词
    const updateArrow = useCallback(
        (a: Arrow) => {
            setArrow(a);
            // 同步触发的同步
            if (autoMode) {
                setPromptText(autoPromptFromArrow(a, areaSize.w, areaSize.h));
            }
        },
        [autoMode, areaSize.w, areaSize.h],
    );

    // 初始生成一次自动提示词
    useEffect(() => {
        if (autoMode && !promptText) {
            const text = autoPromptFromArrow(arrow, areaSize.w, areaSize.h);
            setPromptText(text);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 尺寸跟踪
    useEffect(() => {
        const el = areaRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    setAreaSize((prev) => {
                        if (prev.w === width && prev.h === height) return prev;
                        // 首次设置时按比例调整默认箭头
                        if (prev.w === 600 && prev.h === 400) {
                            setArrow((a) => ({ ...a, x0: a.x0 * (width / 600), y0: a.y0 * (height / 400), x1: a.x1 * (width / 600), y1: a.y1 * (height / 400) }));
                        }
                        return { w: width, h: height };
                    });
                }
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // 箭头派生值(实时)
    const d = deriveArrow(arrow, areaSize.w, areaSize.h);

    // ---------- 画布交互 ----------
    const getAreaPos = (clientX: number, clientY: number): { x: number; y: number } => {
        const rect = areaRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const p = getAreaPos(e.clientX, e.clientY);
        const depthOut = e.button === 2;
        const a: Arrow = { ...arrow, x0: p.x, y0: p.y, x1: p.x, y1: p.y, depthOut };
        setArrow(a);
        // 不在此处 syncAutoPrompt——拖拽中会持续更新
        dragRef.current = { started: true, x0: p.x, y0: p.y, depthOut, pointerId: e.pointerId };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragRef.current?.started) return;
        e.preventDefault();
        e.stopPropagation();
        const p = getAreaPos(e.clientX, e.clientY);
        const a: Arrow = { ...arrow, x1: p.x, y1: p.y };
        setArrow(a);
        // === 实时同步提示词 ===
        if (autoMode) {
            setPromptText(autoPromptFromArrow(a, areaSize.w, areaSize.h));
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (!dragRef.current?.started) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = null;
    };

    // 滚轮微调光圈
    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY > 0 ? 1 : -1;
        const next = apertureStep(arrow.strokeWidth, dir as 1 | -1);
        if (next === arrow.strokeWidth) return; // 值不变
        const a = { ...arrow, strokeWidth: next };
        updateArrow(a);
    };

    // 右键菜单阻止
    const handleContext = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    // 生成新视角
    const handleGenerate = useCallback(() => {
        toast.show("已提交,预计30秒");
        setGenerated(true);
        // 写回节点 metadata,关闭标注台后节点进入 generated 态
        onChange({ generated: true });
    }, [toast, onChange]);

    // 键盘：Esc/X 退出，Enter 生成
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const inInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
            }
            if (!inInput && (e.key === "x" || e.key === "X")) {
                e.preventDefault();
                onClose();
                return;
            }
            if (!inInput && e.key === "Enter") {
                e.preventDefault();
                handleGenerate();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose, handleGenerate]);

    // 保存设置
    const updateSettings = (patch: Partial<StudioSettings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            onChange({ settings: next });
            return next;
        });
    };

    // ---------- 渲染辅助 ----------
    const capsule = (label: string) => (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 12px",
                borderRadius: 999,
                background: RED_BG,
                border: `1px solid ${RED_BORDER}`,
                color: RED,
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
            }}
        >
            {label}
        </span>
    );

    const ruleItem = (text: string) => (
        <div style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5, color: "#aaa" }}>
            <span style={{ color: RED, flexShrink: 0, marginTop: 3 }}>■</span>
            <span>{text}</span>
        </div>
    );

    const sectionTitle = (text: string) => (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: RED, fontWeight: 700, marginBottom: 8 }}>
            <span style={{ color: RED }}>■</span>
            {text}
        </div>
    );

    // 箭头 SVG 坐标
    const ax = arrow.x0,
        ay = arrow.y0;
    const bx = arrow.x1,
        by = arrow.y1;
    const dx = bx - ax,
        dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    // 箭头头部三角
    const headSize = Math.min(20, Math.max(10, len * 0.14));
    const ux = dx / len,
        uy = dy / len;
    const hx = bx - ux * headSize,
        hy = by - uy * headSize;
    const perpX = -uy,
        perpY = ux;
    const tip = `${bx},${by}`;
    const leftWing = `${hx + perpX * headSize * 0.5},${hy + perpY * headSize * 0.5}`;
    const rightWing = `${hx - perpX * headSize * 0.5},${hy - perpY * headSize * 0.5}`;

    // 右侧面板宽度固定
    const PANEL_W = 320;

    return (
        <div
            data-canvas-no-zoom
            onContextMenu={handleContext}
            onPointerDown={(e) => {
                // 阻止标记台上所有 pointer 事件被画布劫持
                e.stopPropagation();
            }}
            style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                background: DARK,
                color: "#eee",
                overflow: "hidden",
            }}
        >
            {/* ============ 顶部参数标签条 ============ */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 16px",
                    background: DARK_PANEL,
                    borderBottom: `1px solid rgba(255,255,255,.06)`,
                    flexShrink: 0,
                    flexWrap: "wrap",
                }}
            >
                {capsule(`焦段${d.focal}mm`)}
                {capsule(`光圈 f/${formatAperture(d.aperture)}`)}
                {capsule(`左右·朝画面${d.lateral}侧`)}
                {capsule(`上下·${d.pitchDeg >= 0 ? "俯" : "仰"}拍约${Math.abs(d.pitchDeg)}°`)}
                {capsule(`纵深·朝画面${d.depth}`)}
                <span style={{ flex: 1 }} />
                <button
                    type="button"
                    title="关闭标注台 (Esc / X)"
                    onClick={onClose}
                    style={{
                        background: "transparent",
                        border: "none",
                        color: "#666",
                        fontSize: 18,
                        cursor: "pointer",
                        padding: "4px 8px",
                        borderRadius: 6,
                        lineHeight: 1,
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    ✕
                </button>
            </div>

            {/* ============ 主体 ============ */}
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
                {/* 画布交互区 */}
                <div
                    ref={areaRef}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onWheel={handleWheel}
                    onContextMenu={handleContext}
                    style={{
                        flex: 1,
                        position: "relative",
                        overflow: "hidden",
                        cursor: "crosshair",
                        background: DARK,
                        // 场景图背景
                        ...(meta.image ? { backgroundImage: `url(${meta.image})`, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" } : {}),
                    }}
                >
                    {/* SVG 箭头层 */}
                    <svg
                        width="100%"
                        height="100%"
                        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
                    >
                        {/* 红色外发光滤镜 */}
                        <defs>
                            <filter id="redGlow">
                                <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor={RED} floodOpacity="0.6" />
                            </filter>
                        </defs>
                        {/* 杆 */}
                        <line
                            x1={ax}
                            y1={ay}
                            x2={bx}
                            y2={by}
                            stroke={RED}
                            strokeWidth={arrow.strokeWidth}
                            strokeLinecap="round"
                            filter="url(#redGlow)"
                        />
                        {/* 箭头头部三角 */}
                        <polygon points={`${tip} ${leftWing} ${rightWing}`} fill={RED} filter="url(#redGlow)" />
                        {/* 机位端实心圆白边 */}
                        <circle cx={ax} cy={ay} r={Math.max(6, arrow.strokeWidth * 0.7)} fill={RED} stroke="#fff" strokeWidth={1.5} filter="url(#redGlow)" />
                    </svg>

                    {/* 左下操作提示 */}
                    <div
                        style={{
                            position: "absolute",
                            left: 12,
                            bottom: 12,
                            fontSize: 11,
                            color: "rgba(255,255,255,.35)",
                            pointerEvents: "none",
                            lineHeight: 1.6,
                        }}
                    >
                        <div>左键拖拽画箭头 · 右键拖拽纵深轴 · 滚轮微调光圈 · 回车提交</div>
                    </div>
                </div>

                {/* 右侧面板 */}
                <div
                    style={{
                        width: PANEL_W,
                        flexShrink: 0,
                        display: "flex",
                        flexDirection: "column",
                        background: DARK_PANEL,
                        borderLeft: `1px solid rgba(255,255,255,.06)`,
                        overflow: "auto",
                        fontSize: 12,
                        padding: "12px 14px",
                        boxSizing: "border-box",
                    }}
                >
                    {/* ---- 上半部:规则说明 ---- */}
                    {sectionTitle("镜头方向规则")}
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid rgba(255,255,255,.06)` }}>
                        {ruleItem("左键拖拽:绘制/替换箭头(尾=机位,尖=方向)")}
                        {ruleItem("箭头长度:焦段 18-200mm")}
                        {ruleItem("杆粗细:光圈 f/1.4-f/16")}
                        {ruleItem("垂直分量:俯仰角 ±45°")}
                        {ruleItem("右键拖拽:纵深轴(朝画面前方退出)")}
                        {ruleItem("滚轮:微调光圈")}
                        {ruleItem("回车:提交生成(mock)")}
                    </div>

                    {/* ---- 下半部:生成新视角 ---- */}
                    {sectionTitle("生成新视角")}

                    {/* 提示词标题 */}
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 6, lineHeight: 1.4 }}>
                        改视角指令(按箭头焦段与光圈自动生成)
                    </div>

                    {/* 深色文本域 + 恢复按钮 */}
                    <div style={{ position: "relative", marginBottom: 10 }}>
                        <textarea
                            ref={promptRef}
                            value={promptText}
                            onChange={(e) => {
                                setPromptText(e.target.value);
                                if (autoMode) setAutoMode(false);
                            }}
                            rows={8}
                            spellCheck={false}
                            style={{
                                width: "100%",
                                boxSizing: "border-box",
                                resize: "vertical",
                                borderRadius: 10,
                                border: `1px solid rgba(255,255,255,.12)`,
                                background: DARK_INPUT,
                                color: "#ccc",
                                padding: "10px 12px",
                                fontSize: 12,
                                lineHeight: 1.6,
                                outline: "none",
                                fontFamily: "inherit",
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                        />
                        {!autoMode ? (
                            <button
                                type="button"
                                title="恢复自动生成"
                                onClick={() => {
                                    setAutoMode(true);
                                    setPromptText(autoPromptFromArrow(arrow, areaSize.w, areaSize.h));
                                }}
                                style={{
                                    position: "absolute",
                                    top: 6,
                                    right: 6,
                                    padding: "3px 8px",
                                    borderRadius: 6,
                                    background: RED_BG,
                                    border: `1px solid ${RED_BORDER}`,
                                    color: RED,
                                    fontSize: 10,
                                    cursor: "pointer",
                                    lineHeight: 1,
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                恢复自动生成
                            </button>
                        ) : null}
                    </div>

                    {/* 设置行 */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ color: "#888", fontSize: 11, width: 44, flexShrink: 0 }}>分辨率</span>
                            <select
                                value={settings.resolution}
                                onChange={(e) => updateSettings({ resolution: e.target.value })}
                                onMouseDown={(e) => e.stopPropagation()}
                                onPointerDown={(e) => e.stopPropagation()}
                                style={selectStyle}
                            >
                                <option>2K</option>
                                <option>4K</option>
                            </select>
                            <span style={{ color: "#888", fontSize: 11, width: 32, flexShrink: 0, textAlign: "right" }}>画质</span>
                            <select
                                value={settings.quality}
                                onChange={(e) => updateSettings({ quality: e.target.value })}
                                onMouseDown={(e) => e.stopPropagation()}
                                onPointerDown={(e) => e.stopPropagation()}
                                style={selectStyle}
                            >
                                <option>高质量</option>
                                <option>超高质量</option>
                            </select>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ color: "#888", fontSize: 11, width: 44, flexShrink: 0 }}>比例</span>
                            <select
                                value={settings.ratio}
                                onChange={(e) => updateSettings({ ratio: e.target.value })}
                                onMouseDown={(e) => e.stopPropagation()}
                                onPointerDown={(e) => e.stopPropagation()}
                                style={selectStyle}
                            >
                                <option>16:9</option>
                                <option>9:16</option>
                                <option>1:1</option>
                                <option>自定义</option>
                            </select>
                            {settings.ratio === "自定义" ? (
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                    <input
                                        type="number"
                                        min={0.1}
                                        max={10}
                                        step={0.05}
                                        value={ratioCustom}
                                        onChange={(e) => {
                                            const v = e.target.value;
                                            setRatioCustom(v);
                                            updateSettings({ customRatio: v });
                                        }}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        style={{
                                            ...inputStyle,
                                            width: 64,
                                            height: 28,
                                            textAlign: "center",
                                        }}
                                    />
                                    <span style={{ color: "#888", fontSize: 11 }}>:1</span>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    {/* 生成按钮 */}
                    <button
                        type="button"
                        onClick={handleGenerate}
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            height: 38,
                            borderRadius: 10,
                            background: RED,
                            color: "#fff",
                            fontSize: 14,
                            fontWeight: 700,
                            border: "none",
                            cursor: "pointer",
                            letterSpacing: 1,
                            marginBottom: 14,
                        }}
                    >
                        生成新视角
                    </button>

                    {/* ---- 底部结果流 ---- */}
                    {sectionTitle("新视角画面")}
                    <div style={{ display: "flex", gap: 8 }}>
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                style={{
                                    flex: 1,
                                    aspectRatio: ratioAspect(settings.ratio, ratioCustom),
                                    borderRadius: 8,
                                    background: generated ? "linear-gradient(135deg,#2a1a1a,#1a1a2a)" : "#1c1c1e",
                                    border: `1px solid ${generated ? RED_BORDER : "rgba(255,255,255,.08)"}`,
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: 4,
                                    fontSize: 10,
                                    color: generated ? RED : "#555",
                                }}
                            >
                                {generated ? (
                                    <>
                                        <span style={{ fontSize: 16 }}>🖼</span>
                                        <span style={{ fontSize: 9, color: "#888", marginTop: 2 }}>新视角 {i + 1}</span>
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toast.show("已发送到画布(mock)");
                                            }}
                                            onMouseDown={(e) => e.stopPropagation()}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            style={{
                                                padding: "2px 8px",
                                                borderRadius: 6,
                                                background: RED_BG,
                                                border: `1px solid ${RED_BORDER}`,
                                                color: RED,
                                                fontSize: 9,
                                                cursor: "pointer",
                                                marginTop: 2,
                                            }}
                                        >
                                            发送到画布
                                        </button>
                                    </>
                                ) : (
                                    <span style={{ opacity: 0.4 }}>等待生成</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

// 选择框样式
const selectStyle: React.CSSProperties = {
    height: 28,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,.12)",
    background: DARK_INPUT,
    color: "#ccc",
    fontSize: 12,
    padding: "0 8px",
    outline: "none",
    cursor: "pointer",
    flex: 1,
    minWidth: 0,
};

const inputStyle: React.CSSProperties = {
    height: 28,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,.12)",
    background: DARK_INPUT,
    color: "#ccc",
    fontSize: 12,
    padding: "0 8px",
    outline: "none",
};

function ratioAspect(ratio: string, custom: string): number {
    if (ratio === "16:9") return 16 / 9;
    if (ratio === "9:16") return 9 / 16;
    if (ratio === "1:1") return 1;
    const n = parseFloat(custom) || 2.35;
    return n / 1;
}