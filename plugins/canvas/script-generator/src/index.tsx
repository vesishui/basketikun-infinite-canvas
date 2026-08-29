// 脚本生成器节点插件:
//   initial   → 三个入口按钮(剧本/角色/自己编写)
//   input     → 上游预览 + 参考图 + textarea + 模型 + 发送
//   progress  → 三步 stepper + 工具条 + 打开脚本节点
//   full      → 同 progress(步骤全完成,批量按钮点亮)
// 全屏编辑器(三步) / 批量生图 / 批量生视频 通过 fullscreenPanel 在视口级渲染,全部 mock,不发任何网络请求。
import { definePlugin, useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodePanelProps } from "@infinite-canvas/plugin-sdk";

import { BatchModal, type BatchMode } from "./batch-modal";
import { ScriptEditor } from "./editor";
import { IMAGE_MODELS, MOCK_STYLE_PROMPT, makeInitialMeta } from "./mock";
import type { ScriptMeta, Stage, StepKey } from "./types";
import { Select, btn, disabledBtn, primaryBtn, stop, useT, useToast } from "./ui";

const STEP_LABELS: Array<{ key: StepKey; label: string }> = [
    { key: "shots", label: "确认镜头" },
    { key: "assets", label: "准备资产" },
    { key: "prompts", label: "合成提示词" },
];

function readMeta(node: CanvasNodeContext["node"]): ScriptMeta {
    const m = node.metadata ?? {};
    return {
        stage: (m.stage as Stage) || "initial",
        steps: { shots: Boolean((m.steps as Partial<Record<StepKey, boolean>> | undefined)?.shots), assets: Boolean((m.steps as Partial<Record<StepKey, boolean>> | undefined)?.assets), prompts: Boolean((m.steps as Partial<Record<StepKey, boolean>> | undefined)?.prompts) },
        shots: Array.isArray(m.shots) ? (m.shots as ScriptMeta["shots"]) : [],
        assets: (m.assets as ScriptMeta["assets"]) || { characters: [], scenes: [], props: [] },
        stylePrompt: (m.stylePrompt as string) || MOCK_STYLE_PROMPT,
        prompts: Array.isArray(m.prompts) ? (m.prompts as ScriptMeta["prompts"]) : [],
        inputPrompt: (m.inputPrompt as string) || "",
        referenceImage: m.referenceImage as string | undefined,
        model: (m.model as string) || IMAGE_MODELS[0],
    };
}

function ScriptGeneratorContent({ ctx }: CanvasNodeContentProps) {
    const t = useT(ctx.theme);
    const meta = readMeta(ctx.node);
    const [tip, setTip] = useState<string | null>(null);
    const tipRef = useRef<{ x: number; y: number } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    // 节点内联提示(不依赖 fixed,避免被画布缩放变换破坏)
    const [notice, setNotice] = useState<string | null>(null);
    const noticeTimerRef = useRef<number | null>(null);

    const update = useCallback((patch: Partial<ScriptMeta>) => ctx.updateMetadata(patch), [ctx]);

    const showNotice = useCallback((text: string) => {
        setNotice(text);
        if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2000);
    }, []);

    // 打开全屏面板(编辑器 / 批量弹窗)
    const openFullscreen = useCallback(
        (panelMode: "editor" | "batch-image" | "batch-video") => {
            ctx.updateMetadata({ panelMode });
            ctx.openPanel();
        },
        [ctx],
    );

    // 首次打开:若没有分镜数据,注入 mock 初始数据
    const initedRef = useRef(false);
    useEffect(() => {
        if (initedRef.current) return;
        initedRef.current = true;
        if (!Array.isArray(ctx.node.metadata?.shots) || !(ctx.node.metadata?.shots as unknown[]).length) {
            const init = makeInitialMeta();
            update({ shots: init.shots, assets: init.assets, prompts: init.prompts, stylePrompt: init.stylePrompt, model: init.model });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // input 态:发送(mock 生成 → 打开编辑器)
    const handleSend = () => {
        if (!meta.inputPrompt.trim()) {
            showNotice("请先描述剧情片段或故事");
            return;
        }
        showNotice("正在生成分镜脚本(mock)…");
        window.setTimeout(() => openFullscreen("editor"), 700);
    };

    // 上传参考图(本地 FileReader,不发请求)
    const pickReference = (file: File | undefined) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => update({ referenceImage: String(reader.result || "") });
        reader.readAsDataURL(file);
    };

    // 上游文本预览(未连接为空)
    const upstreamText = ctx
        .getUpstream()
        .map((node) => node.metadata?.content)
        .find((c): c is string => typeof c === "string" && Boolean(c.trim()));

    const stepsDone = meta.steps.shots && meta.steps.assets && meta.steps.prompts;
    const showToolbar = meta.stage === "progress" || meta.stage === "full";

    // 工具条按钮(带 tooltip)
    const toolbarBtn = (title: string, label: string, icon: string, onClick: () => void, disabled = false, tipText?: string) => (
        <button
            type="button"
            title={tipText || title}
            onMouseDown={stop}
            onClick={onClick}
            onMouseEnter={(e) => {
                if (tipText) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    tipRef.current = { x: rect.left + rect.width / 2, y: rect.top };
                    setTip(tipText);
                }
            }}
            onMouseLeave={() => setTip(null)}
            style={disabled ? disabledBtn(t) : btn(t)}
        >
            {icon} {label}
        </button>
    );

    return (
        <div data-canvas-no-zoom style={{ position: "relative", height: "100%", width: "100%", display: "flex", flexDirection: "column", overflow: "hidden", boxSizing: "border-box" }}>
            {/* ============ initial:三个竖排入口 ============ */}
            {meta.stage === "initial" ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, padding: 14, justifyContent: "center" }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: t.text, textAlign: "center", marginBottom: 2 }}>📜 脚本生成器</span>
                    {[
                        { icon: "📝", label: "剧本生成分镜脚本", action: () => update({ stage: "input" }) },
                        { icon: "👤", label: "角色生成分镜脚本", action: () => update({ stage: "input" }) },
                        { icon: "✍️", label: "自己编写分镜脚本", action: () => openFullscreen("editor") },
                    ].map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            onMouseDown={stop}
                            onClick={item.action}
                            style={{ display: "flex", alignItems: "center", gap: 10, height: 42, padding: "0 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: "transparent", color: t.text, fontSize: 13, cursor: "pointer", transition: "background .12s" }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = t.bg)}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                            <span style={{ fontSize: 16 }}>{item.icon}</span>
                            {item.label}
                        </button>
                    ))}
                </div>
            ) : null}

            {/* ============ input:上游预览 + 输入区 ============ */}
            {meta.stage === "input" ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, padding: 10, boxSizing: "border-box", minHeight: 0 }}>
                    {/* 上游文本预览 */}
                    <div style={{ height: 60, flexShrink: 0, borderRadius: 10, border: `1px solid ${t.border}`, background: t.bg, padding: "6px 10px", overflow: "hidden" }}>
                        <div style={{ fontSize: 10, color: t.faint, marginBottom: 2 }}>上游文本预览</div>
                        <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {upstreamText || "未连接上游文本节点(可留空,直接在下方描述)"}
                        </div>
                    </div>
                    {/* 参考图 */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickReference(e.target.files?.[0])} />
                        <button type="button" onMouseDown={stop} onClick={() => fileRef.current?.click()} style={btn(t)} title="上传参考图(本地读取,不发请求)">
                            🖼 参考图
                        </button>
                        {meta.referenceImage ? <img src={meta.referenceImage} alt="参考图" style={{ width: 34, height: 34, borderRadius: 8, objectFit: "cover", border: `1px solid ${t.border}` }} /> : null}
                    </div>
                    {/* 大 textarea */}
                    <textarea
                        value={meta.inputPrompt}
                        onChange={(e) => update({ inputPrompt: e.target.value })}
                        placeholder="描述剧情片段、故事,为你生成分镜脚本"
                        onMouseDown={stop}
                        onPointerDown={stop}
                        onWheel={(e) => e.stopPropagation()}
                        style={{ flex: 1, width: "100%", boxSizing: "border-box", resize: "none", borderRadius: 10, border: `1px solid ${t.border}`, background: t.bg, color: t.text, padding: "10px 12px", fontSize: 12, lineHeight: 1.6, outline: "none", fontFamily: "inherit" }}
                    />
                    {/* 底部:模型 + 发送 */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <Select t={t} value={meta.model} options={IMAGE_MODELS} onChange={(v) => update({ model: v })} title="模型" />
                        <span style={{ flex: 1 }} />
                        <button type="button" onMouseDown={stop} onClick={handleSend} style={primaryBtn(t)}>
                            发送 →
                        </button>
                    </div>
                </div>
            ) : null}

            {/* ============ progress / full:工具条 + stepper ============ */}
            {showToolbar ? (
                <>
                    {/* 常驻工具条 */}
                    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", borderBottom: `1px solid ${t.border}`, background: t.panel, flexShrink: 0, position: "relative", flexWrap: "wrap" }}>
                        {toolbarBtn("重新生成", "重新生成", "🔄", () => update({ stage: "input" }))}
                        {toolbarBtn("批量生成分镜", "批量生成分镜", "🖼", () => openFullscreen("batch-image"), !stepsDone, stepsDone ? undefined : "需先完成三步步骤,才能批量生成分镜")}
                        {toolbarBtn("批量生视频", "批量生视频", "🎬", () => openFullscreen("batch-video"), !stepsDone, stepsDone ? undefined : "需先完成三步步骤,才能批量生视频")}
                        {toolbarBtn("导出", "导出", "⬇", () => showNotice("已导出分镜脚本(mock)"), false)}
                        {/* tooltip 浮层(fixed 在节点工具条上方,画布缩放时位置略有偏差可接受;也用 body 坐标系近似) */}
                        {tip ? (
                            <div
                                style={{
                                    position: "fixed",
                                    left: (tipRef.current?.x ?? 0) - 80,
                                    top: (tipRef.current?.y ?? 0) - 34,
                                    zIndex: 260,
                                    padding: "5px 10px",
                                    borderRadius: 7,
                                    background: "rgba(28,25,23,.94)",
                                    color: "#fff",
                                    fontSize: 11,
                                    whiteSpace: "nowrap",
                                    pointerEvents: "none",
                                    boxShadow: "0 4px 16px rgba(0,0,0,.3)",
                                }}
                            >
                                {tip}
                            </div>
                        ) : null}
                    </div>
                    {/* stepper + 打开脚本节点 */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 12, minHeight: 0 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                            {STEP_LABELS.map((step) => {
                                const done = meta.steps[step.key];
                                return (
                                    <div key={step.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <span style={{ display: "grid", placeItems: "center", width: 20, height: 20, borderRadius: "50%", background: done ? "#06b6d4" : t.border, color: done ? "#fff" : t.muted, fontSize: 11, flexShrink: 0 }}>
                                            {done ? "✓" : ""}
                                        </span>
                                        <span style={{ fontSize: 12, color: done ? t.text : t.muted }}>{step.label}</span>
                                        {done ? <span style={{ fontSize: 10, color: "#0e7490", background: "rgba(6,182,212,.14)", padding: "2px 8px", borderRadius: 999 }}>已完成</span> : null}
                                    </div>
                                );
                            })}
                        </div>
                        <button type="button" onMouseDown={stop} onClick={() => openFullscreen("editor")} style={primaryBtn(t)}>
                            打开脚本节点 →
                        </button>
                    </div>
                </>
            ) : null}

            {/* 节点内联提示条 */}
            {notice ? (
                <div style={{ position: "absolute", left: 10, right: 10, bottom: 8, padding: "6px 12px", borderRadius: 8, background: "rgba(6,182,212,.14)", border: "1px solid rgba(6,182,212,.4)", color: "#0e7490", fontSize: 11, textAlign: "center", zIndex: 20 }}>
                    {notice}
                </div>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 全屏 Panel:渲染脚本编辑器 / 批量弹窗(宿主按 fullscreenPanel 用视口级 fixed 容器渲染)
// ---------------------------------------------------------------------------
function ScriptGeneratorPanel({ ctx, onClose }: CanvasNodePanelProps) {
    const meta = readMeta(ctx.node);
    const { toast, toastNode } = useToast();
    const update = useCallback((patch: Partial<ScriptMeta>) => ctx.updateMetadata(patch), [ctx]);
    const panelMode = ctx.node.metadata?.panelMode as string | undefined;

    // 关闭编辑器:按已完成步骤切换节点外观
    const closeAll = () => {
        const steps = meta.steps;
        let nextStage: Stage = meta.stage;
        if (steps.prompts) nextStage = "full";
        else if (steps.shots) nextStage = "progress";
        // 一个步骤都没完成:保持当前外观(initial 或 input)
        ctx.updateMetadata({ stage: nextStage, panelMode: undefined });
        onClose();
    };

    const closeBatch = () => {
        ctx.updateMetadata({ panelMode: undefined });
        onClose();
    };

    if (panelMode === "batch-image" || panelMode === "batch-video") {
        const mode: BatchMode = panelMode === "batch-image" ? "image" : "video";
        return (
            <>
                <BatchModal mode={mode} theme={ctx.theme} shots={meta.shots} onClose={closeBatch} toast={toast} />
                {toastNode}
            </>
        );
    }

    // 默认:全屏脚本编辑器
    return (
        <>
            <ScriptEditor ctx={ctx} meta={meta} onChange={update} onClose={closeAll} toast={toast} />
            {toastNode}
        </>
    );
}

export default definePlugin({
    id: "script-generator",
    name: "脚本生成器",
    version: "1.0.0",
    description: "从剧本/故事生成分镜脚本:三步流程(确认镜头/准备资产/合成提示词),支持批量生图与生视频(mock)",
    nodes: [
        {
            type: "script-generator:board",
            title: "脚本生成器",
            icon: "📜",
            description: "剧本 → 分镜脚本生成器",
            defaultSize: { width: 340, height: 300 },
            defaultMetadata: { stage: "initial" },
            minimapColor: "#06b6d4",
            // 作为上游被消费时输出脚本描述
            resource: (node) => ({ kind: "text", text: (node.metadata?.inputPrompt as string) || "脚本生成器节点" }),
            Content: ScriptGeneratorContent,
            // 在视口级 fixed 容器渲染(不受画布缩放变换影响),承载全屏编辑器与批量弹窗
            fullscreenPanel: true,
            Panel: ScriptGeneratorPanel,
        },
    ],
});
