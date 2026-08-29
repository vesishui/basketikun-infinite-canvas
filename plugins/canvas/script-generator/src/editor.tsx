// 脚本生成器插件 —— 全屏脚本编辑器(三步:确认镜头 → 准备资产 → 合成提示词)
// 全部 mock:不发任何网络请求;编辑实时写回 metadata(遮罩盖住节点,重渲染无感知)。
import { useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

import { ACCENT, ACCENT_BG, ACCENT_DIM, ROW_COLORS, parseEntities } from "./mock";
import type { Asset, AssetGroup, AssetKind, ScriptMeta, Shot, ShotPrompt, StepKey } from "./types";
import { HighlightText, Select, btn, inputStyle, primaryBtn, stop, useT, type T, type ToastApi } from "./ui";

type EditorProps = {
    ctx: CanvasNodeContext;
    meta: ScriptMeta;
    onChange: (patch: Partial<ScriptMeta>) => void;
    onClose: () => void;
    toast: ToastApi;
};

const STEPS: Array<{ key: StepKey; label: string }> = [
    { key: "shots", label: "确认镜头" },
    { key: "assets", label: "准备资产" },
    { key: "prompts", label: "合成提示词" },
];

// 表格列定义(横向滚动)
const COLS: Array<{ key: string; label: string; width: number }> = [
    { key: "number", label: "镜号", width: 56 },
    { key: "duration", label: "时长", width: 72 },
    { key: "description", label: "画面描述", width: 260 },
    { key: "shotSize", label: "景别", width: 88 },
    { key: "lighting", label: "光影氛围", width: 140 },
    { key: "dialogue", label: "对白旁白", width: 170 },
    { key: "sound", label: "音效", width: 130 },
    { key: "cameraMove", label: "运镜", width: 86 },
    { key: "finalPrompt", label: "最终提示词", width: 230 },
    { key: "actions", label: "操作", width: 64 },
];

export function ScriptEditor({ ctx, meta, onChange, onClose, toast }: EditorProps) {
    const t = useT(ctx.theme);
    const [active, setActive] = useState<StepKey>(meta.steps.shots ? (meta.steps.assets ? "prompts" : "assets") : "shots");

    // ---- 通用单元格编辑 ----
    const [cell, setCell] = useState<{ shotId: string; field: keyof Shot } | null>(null);
    const [cellValue, setCellValue] = useState("");

    // ---- 画面描述编辑浮层 ----
    const [descEdit, setDescEdit] = useState<{ shotId: string; left: number; top: number } | null>(null);
    const [descValue, setDescValue] = useState("");
    const [atOpen, setAtOpen] = useState(false);
    const [atQuery, setAtQuery] = useState("");

    // ---- 操作 … 弹窗 / Step3 提示词弹窗 ----
    const [menuShot, setMenuShot] = useState<string | null>(null);
    const [promptShot, setPromptShot] = useState<string | null>(null);

    // ---- Step2 资产 ----
    const [generatingAssets, setGeneratingAssets] = useState(false);

    const updateShots = (next: Shot[]) => onChange({ shots: next });
    const updateShot = (id: string, patch: Partial<Shot>) => updateShots(meta.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const updateAssets = (next: AssetGroup) => onChange({ assets: next });

    // ---------------- 通用单元格 ----------------
    const startCell = (shot: Shot, field: keyof Shot) => {
        setCell({ shotId: shot.id, field });
        setCellValue(String(shot[field] ?? ""));
    };
    const commitCell = () => {
        if (!cell) return;
        const raw = cellValue;
        if (cell.field === "duration") {
            updateShot(cell.shotId, { duration: Math.max(1, Math.min(30, Number(raw) || 5)) });
        } else {
            updateShot(cell.shotId, { [cell.field]: raw } as Partial<Shot>);
        }
        setCell(null);
    };

    // ---------------- 画面描述浮层(@ 引用素材) ----------------
    const openDescEdit = (shot: Shot, e: React.MouseEvent) => {
        e.stopPropagation();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setDescValue(shot.description);
        setDescEdit({ shotId: shot.id, left: rect.left, top: rect.bottom + 6 });
        setAtOpen(false);
    };
    const saveDesc = (shotId: string, value: string) => {
        const { text, entities } = parseEntities(value);
        updateShot(shotId, { description: value, entities });
    };
    const onDescChange = (value: string) => {
        setDescValue(value);
        // 输入 @ 弹出资产候选
        const tail = value.slice(-1);
        if (tail === "@") {
            setAtQuery("");
            setAtOpen(true);
        } else if (atOpen) {
            const after = value.split("@").pop() || "";
            setAtQuery(after);
        }
    };
    const pickAsset = (name: string) => {
        const next = descValue.replace(/@[^@]*$/, `[[${name}]] `);
        setDescValue(next);
        setAtOpen(false);
        setAtQuery("");
    };

    // ---------------- 操作 … 弹窗 ----------------
    const rowBg = (shot: Shot) => (shot.rowColor ? `${shot.rowColor}26` : "transparent");
    const rowBorder = (shot: Shot) => (shot.rowColor ? shot.rowColor : t.border);

    // ---------------- Step3 提示词 ----------------
    const promptOf = (shotId: string): ShotPrompt => meta.prompts.find((p) => p.shotId === shotId) || { shotId, prompt: "", motionPrompt: "" };
    const updatePrompt = (shotId: string, patch: Partial<Omit<ShotPrompt, "shotId">>) => {
        const exists = meta.prompts.some((p) => p.shotId === shotId);
        const next = exists
            ? meta.prompts.map((p) => (p.shotId === shotId ? { ...p, ...patch } : p))
            : [...meta.prompts, { shotId, prompt: "", motionPrompt: "", ...patch }];
        onChange({ prompts: next });
    };
    const generateAllPrompts = () => {
        onChange({
            prompts: meta.shots.map((shot) => ({
                shotId: shot.id,
                prompt: shot.finalPrompt,
                motionPrompt: "镜头" + shot.cameraMove + ",画面平稳,细节丰富",
            })),
        });
        toast.show("已一键生成全部提示词(mock)");
    };

    // ---------------- Step2 资产 ----------------
    const assetGroups: Array<{ key: keyof AssetGroup; label: string }> = [
        { key: "characters", label: "角色" },
        { key: "scenes", label: "场景" },
        { key: "props", label: "道具" },
    ];
    const allAssets: Asset[] = [...meta.assets.characters, ...meta.assets.scenes, ...meta.assets.props];
    const missingAssetCount = allAssets.filter((a) => !a.image).length;
    const generateAllAssets = () => {
        setGeneratingAssets(true);
        // mock 生成动画后全部标记已生成
        window.setTimeout(() => {
            const fill = (list: Asset[]): Asset[] => list.map((a) => ({ ...a, image: a.image || "mock:generated" }));
            updateAssets({
                characters: fill(meta.assets.characters),
                scenes: fill(meta.assets.scenes),
                props: fill(meta.assets.props),
            });
            setGeneratingAssets(false);
        }, 900);
    };

    // ---------------- 步骤标记与导航 ----------------
    const markStep = (key: StepKey) => {
        if (key === "shots") onChange({ steps: { ...meta.steps, shots: true } });
        if (key === "assets") onChange({ steps: { ...meta.steps, assets: true } });
        if (key === "prompts") onChange({ steps: { ...meta.steps, prompts: true } });
    };
    const gotoStep = (key: StepKey) => {
        const order = ["shots", "assets", "prompts"] as const;
        const cur = order.indexOf(active);
        const target = order.indexOf(key);
        // 只能跳到自己或已解锁的后续步骤(需前置完成)
        if (target > cur && key === "prompts" && !meta.steps.assets) {
            toast.show("请先完成前置步骤:准备资产");
            return;
        }
        if (target > cur && key === "assets" && !meta.steps.shots) {
            toast.show("请先完成前置步骤:确认镜头");
            return;
        }
        setActive(key);
    };
    const nextFromShots = () => {
        markStep("shots");
        setActive("assets");
    };
    const nextFromAssets = () => {
        markStep("assets");
        setActive("prompts");
    };

    const assetImage = (asset: Asset) =>
        asset.image === "mock:generated" ? (
            <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${ACCENT}55, #8b5cf655)`, color: "#fff", fontSize: 22, fontWeight: 700 }}>
                {asset.name.slice(0, 1)}
            </div>
        ) : asset.image ? (
            <img src={asset.image} alt={asset.name} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        ) : (
            <div style={{ display: "grid", placeItems: "center", height: "100%", color: t.faint, fontSize: 11, textAlign: "center", padding: 8, boxSizing: "border-box" }}>
                生成或上传{asset.kind === "character" ? "角色" : asset.kind === "scene" ? "场景" : "道具"}图
            </div>
        );

    return (
        <div data-canvas-no-zoom style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", flexDirection: "column", background: t.canvas, color: t.text }}>
            {/* 顶栏:标题 + 居中 stepper + 右上 X */}
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 16px", borderBottom: `1px solid ${t.border}`, background: t.panel, flexShrink: 0 }}>
                <div style={{ position: "absolute", left: 16, fontSize: 14, fontWeight: 700 }}>📜 脚本生成器</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }} onMouseDown={stop}>
                    {STEPS.map((step, i) => {
                        const done = meta.steps[step.key];
                        const current = active === step.key;
                        return (
                            <div key={step.key} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => gotoStep(step.key)}>
                                {i > 0 ? <div style={{ width: 36, height: 1, background: done || current ? ACCENT : t.border }} /> : null}
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 7,
                                        padding: "5px 14px",
                                        borderRadius: 999,
                                        border: `1px solid ${current ? ACCENT : t.border}`,
                                        background: current ? ACCENT_BG : done ? `${ACCENT}22` : "transparent",
                                        color: current ? ACCENT : done ? ACCENT_DIM : t.muted,
                                        fontSize: 12,
                                        fontWeight: current ? 700 : 500,
                                    }}
                                >
                                    <span style={{ display: "grid", placeItems: "center", width: 18, height: 18, borderRadius: "50%", background: done ? ACCENT : current ? ACCENT : t.border, color: done || current ? "#fff" : t.muted, fontSize: 10 }}>
                                        {done ? "✓" : i + 1}
                                    </span>
                                    {step.label}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <button
                    type="button"
                    title="关闭"
                    onClick={onClose}
                    onMouseDown={stop}
                    style={{ position: "absolute", right: 14, ...btn(t, { width: 30, height: 30, padding: 0, borderRadius: "50%", fontSize: 16 }) }}
                >
                    ✕
                </button>
            </div>

            {/* 内容区 */}
            <div style={{ flex: 1, overflow: "auto", minHeight: 0, position: "relative" }}>
                {/* ================= Step1 / Step3 表格 ================= */}
                {(active === "shots" || active === "prompts") && (
                    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                        <div style={{ flex: 1, overflow: "auto", padding: 16, boxSizing: "border-box" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                                <span style={{ fontSize: 14, fontWeight: 700 }}>{active === "prompts" ? "合成提示词" : "确认镜头"}</span>
                                <span style={{ fontSize: 12, color: t.muted }}>
                                    {active === "prompts" ? "每镜的最终提示词由分镜信息合成,可逐镜调整" : "点击单元格编辑,双击画面描述可引用素材"}
                                </span>
                            </div>
                            <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, overflow: "auto", background: t.panel }}>
                                <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%" }}>
                                    <thead>
                                        <tr>
                                            {COLS.map((col) => (
                                                <th
                                                    key={col.key}
                                                    style={{
                                                        padding: "8px 10px",
                                                        fontSize: 11,
                                                        fontWeight: 600,
                                                        textAlign: "left",
                                                        borderBottom: `1px solid ${t.border}`,
                                                        borderRight: `1px solid ${t.border}`,
                                                        background: t.panel,
                                                        color: col.key === "finalPrompt" && active === "prompts" ? ACCENT_DIM : t.muted,
                                                        minWidth: col.width,
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {col.label}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {meta.shots.map((shot) => {
                                            const isEditing = cell?.shotId === shot.id;
                                            return (
                                                <tr key={shot.id} style={{ background: rowBg(shot) }}>
                                                    {/* 镜号 */}
                                                    <Cell t={t} width={COLS[0].width}>
                                                        <b style={{ color: t.text }}>{String(shot.number).padStart(2, "0")}</b>
                                                    </Cell>
                                                    {/* 时长 */}
                                                    <Cell t={t} width={COLS[1].width}>
                                                        {isEditing && cell?.field === "duration" ? (
                                                            <input autoFocus type="number" min={1} max={30} value={cellValue} onChange={(e) => setCellValue(e.target.value)} onBlur={commitCell} onKeyDown={(e) => e.key === "Enter" && commitCell()} onMouseDown={stop} style={inputStyle(t, { height: 24, padding: "0 6px", background: rowBg(shot) })} />
                                                        ) : (
                                                            <span style={{ cursor: "text", color: t.text }} onClick={() => startCell(shot, "duration")}>
                                                                {shot.duration}s
                                                            </span>
                                                        )}
                                                    </Cell>
                                                    {/* 画面描述(双击弹编辑浮层,实体词青色高亮) */}
                                                    <Cell t={t} width={COLS[2].width}>
                                                        <div style={{ fontSize: 12, lineHeight: 1.5, cursor: "pointer", color: t.text }} onDoubleClick={(e) => openDescEdit(shot, e)} title="双击编辑(可 @ 引用素材)">
                                                            <HighlightText text={shot.description} />
                                                        </div>
                                                    </Cell>
                                                    {/* 景别 */}
                                                    <Cell t={t} width={COLS[3].width}>
                                                        <EditableText t={t} value={shot.shotSize} editing={isEditing && cell?.field === "shotSize"} valueState={cellValue} onStart={() => startCell(shot, "shotSize")} onValue={setCellValue} onCommit={commitCell} bg={rowBg(shot)} />
                                                    </Cell>
                                                    {/* 光影氛围 */}
                                                    <Cell t={t} width={COLS[4].width}>
                                                        <EditableText t={t} value={shot.lighting} editing={isEditing && cell?.field === "lighting"} valueState={cellValue} onStart={() => startCell(shot, "lighting")} onValue={setCellValue} onCommit={commitCell} bg={rowBg(shot)} />
                                                    </Cell>
                                                    {/* 对白旁白 */}
                                                    <Cell t={t} width={COLS[5].width}>
                                                        <EditableText t={t} value={shot.dialogue} editing={isEditing && cell?.field === "dialogue"} valueState={cellValue} onStart={() => startCell(shot, "dialogue")} onValue={setCellValue} onCommit={commitCell} bg={rowBg(shot)} />
                                                    </Cell>
                                                    {/* 音效 */}
                                                    <Cell t={t} width={COLS[6].width}>
                                                        <EditableText t={t} value={shot.sound} editing={isEditing && cell?.field === "sound"} valueState={cellValue} onStart={() => startCell(shot, "sound")} onValue={setCellValue} onCommit={commitCell} bg={rowBg(shot)} />
                                                    </Cell>
                                                    {/* 运镜 */}
                                                    <Cell t={t} width={COLS[7].width}>
                                                        <EditableText t={t} value={shot.cameraMove} editing={isEditing && cell?.field === "cameraMove"} valueState={cellValue} onStart={() => startCell(shot, "cameraMove")} onValue={setCellValue} onCommit={commitCell} bg={rowBg(shot)} />
                                                    </Cell>
                                                    {/* 最终提示词 */}
                                                    <Cell t={t} width={COLS[8].width}>
                                                        {active === "prompts" ? (
                                                            <PromptCell t={t} done={Boolean(meta.prompts.find((p) => p.shotId === shot.id))} onClick={() => setPromptShot(shot.id)} />
                                                        ) : (
                                                            <EditableText t={t} value={shot.finalPrompt} editing={isEditing && cell?.field === "finalPrompt"} valueState={cellValue} onStart={() => startCell(shot, "finalPrompt")} onValue={setCellValue} onCommit={commitCell} bg={rowBg(shot)} />
                                                        )}
                                                    </Cell>
                                                    {/* 操作 … */}
                                                    <Cell t={t} width={COLS[9].width}>
                                                        <button type="button" title="更多操作" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); setMenuShot(shot.id); }} style={{ ...btn(t, { width: 26, height: 24, padding: 0, borderRadius: 6 }) }}>
                                                            …
                                                        </button>
                                                    </Cell>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                                {/* 添加镜头 */}
                                <div style={{ padding: 10, borderTop: `1px solid ${t.border}` }}>
                                    <button
                                        type="button"
                                        onMouseDown={stop}
                                        onClick={() => {
                                            const next = [...meta.shots, { id: `shot-${Date.now()}`, number: meta.shots.length + 1, duration: 5, description: "[[新场景]] 新镜头画面描述", entities: ["新场景"], shotSize: "中景", lighting: "自然光", dialogue: "", sound: "", cameraMove: "固定", finalPrompt: "新镜头提示词", rowColor: "" }];
                                            updateShots(next);
                                        }}
                                        style={btn(t)}
                                    >
                                        + 添加镜头
                                    </button>
                                </div>
                            </div>
                        </div>
                        {/* 底部操作栏 */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "10px 16px", borderTop: `1px solid ${t.border}`, background: t.panel, flexShrink: 0 }}>
                            {active === "shots" ? (
                                <>
                                    <span style={{ fontSize: 12, color: t.muted }}>{meta.shots.length} 个镜头</span>
                                    <button type="button" onMouseDown={stop} onClick={nextFromShots} style={primaryBtn(t)}>
                                        下一步:准备资产 →
                                    </button>
                                </>
                            ) : (
                                <>
                                    <span style={{ fontSize: 12, color: t.muted }}>提示词将保存到每镜"最终提示词"</span>
                                    <button type="button" onMouseDown={stop} onClick={generateAllPrompts} style={primaryBtn(t)}>
                                        ✨ 一键生成全部提示词
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {/* ================= Step2 准备资产 ================= */}
                {active === "assets" && (
                    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                        <div style={{ flex: 1, overflow: "auto", padding: 16, boxSizing: "border-box" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                                <span style={{ fontSize: 14, fontWeight: 700 }}>准备资产</span>
                                <span style={{ fontSize: 12, color: t.muted }}>为角色/场景/道具准备参考图,生图时优先使用</span>
                            </div>
                            {/* 全局风格描述(青色高亮) */}
                            <div style={{ borderRadius: 10, border: `1px solid ${ACCENT}66`, background: ACCENT_BG, padding: "10px 14px", fontSize: 12, lineHeight: 1.6, color: ACCENT_DIM, marginBottom: 16 }}>
                                <span style={{ fontWeight: 700, color: ACCENT, marginRight: 8 }}>🎨 全局风格</span>
                                {meta.stylePrompt}
                            </div>
                            {/* 三组资产网格 */}
                            {assetGroups.map((group) => (
                                <div key={group.key} style={{ marginBottom: 18 }}>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: t.text, marginBottom: 8 }}>
                                        {group.label}
                                        <span style={{ color: t.muted, fontWeight: 400, marginLeft: 6 }}>{meta.assets[group.key].length} 个</span>
                                    </div>
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
                                        {meta.assets[group.key].map((asset) => (
                                            <div key={asset.id} style={{ position: "relative", borderRadius: 12, border: `1px solid ${asset.image ? ACCENT + "66" : t.border}`, overflow: "hidden", background: t.panel }}>
                                                {/* 图片占位/图 */}
                                                <div style={{ height: 96, borderBottom: `1px solid ${t.border}`, background: t.bg }}>{assetImage(asset)}</div>
                                                <div style={{ padding: 8 }}>
                                                    <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>{asset.name}</div>
                                                    <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.4, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "2.8em" }}>
                                                        {asset.description}
                                                    </div>
                                                </div>
                                                {/* 右上 … 菜单 */}
                                                <button
                                                    type="button"
                                                    title="资产操作"
                                                    onMouseDown={stop}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        toast.show(`资产「${asset.name}」操作菜单(mock)`);
                                                    }}
                                                    style={{ position: "absolute", top: 6, right: 6, ...btn(t, { width: 24, height: 22, padding: 0, borderRadius: 6, background: "rgba(0,0,0,.25)", color: "#fff", border: "none", fontSize: 12 }) }}
                                                >
                                                    …
                                                </button>
                                                {asset.image ? <div style={{ position: "absolute", top: 6, left: 6, fontSize: 10, padding: "2px 6px", borderRadius: 999, background: `${ACCENT}dd`, color: "#fff" }}>已就绪</div> : null}
                                            </div>
                                        ))}
                                        {/* + 新增 */}
                                        <button
                                            type="button"
                                            onMouseDown={stop}
                                            onClick={() => toast.show(`新增${group.label}(mock)`)}
                                            style={{ height: 100, borderRadius: 12, border: `1px dashed ${t.border}`, background: "transparent", color: t.muted, fontSize: 12, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}
                                        >
                                            <span style={{ fontSize: 18 }}>+</span>
                                            新增{group.label}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {/* 底部:未设图提示条 + 一键生成 */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: `1px solid ${t.border}`, background: t.panel, flexShrink: 0 }}>
                            <div style={{ flex: 1, fontSize: 12, color: missingAssetCount ? ACCENT_DIM : t.muted }}>
                                {missingAssetCount ? (
                                    <span style={{ background: ACCENT_BG, borderRadius: 999, padding: "5px 12px", color: ACCENT }}>⚠ 有 {missingAssetCount} 个资产未设置图片</span>
                                ) : (
                                    "所有资产均已就绪 ✓"
                                )}
                            </div>
                            {missingAssetCount ? (
                                <button type="button" disabled={generatingAssets} onMouseDown={stop} onClick={generateAllAssets} style={{ ...primaryBtn(t), opacity: generatingAssets ? 0.6 : 1 }}>
                                    {generatingAssets ? "⏳ 生成中…" : "✨ 一键生成所有资产"}
                                </button>
                            ) : null}
                            <button type="button" onMouseDown={stop} onClick={nextFromAssets} style={primaryBtn(t)}>
                                下一步:合成提示词 →
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ---------------- 画面描述编辑浮层 ---------------- */}
            {descEdit ? (
                <div style={{ position: "fixed", left: Math.min(descEdit.left, window.innerWidth - 360), top: descEdit.top, zIndex: 320, width: 340, borderRadius: 12, border: `1px solid ${t.border}`, background: t.panel, boxShadow: "0 16px 48px rgba(0,0,0,.3)", padding: 10 }} data-canvas-no-zoom>
                    <textarea
                        autoFocus
                        value={descValue}
                        onChange={(e) => onDescChange(e.target.value)}
                        onBlur={() => {
                            saveDesc(descEdit.shotId, descValue);
                            setDescEdit(null);
                        }}
                        rows={4}
                        placeholder="描述画面,输入 @ 选择资产引用"
                        style={{ ...inputStyle(t), resize: "vertical", lineHeight: 1.5, borderColor: atOpen ? ACCENT : t.border }}
                        onMouseDown={stop}
                        onPointerDown={stop}
                    />
                    {/* @ 资产候选 */}
                    {atOpen ? (
                        <div style={{ marginTop: 6, border: `1px solid ${t.border}`, borderRadius: 10, overflow: "hidden", maxHeight: 150, overflowY: "auto", background: t.panel }}>
                            {allAssets.filter((a) => !atQuery || a.name.includes(atQuery)).map((a) => (
                                <button key={a.id} type="button" onMouseDown={(e) => { e.stopPropagation(); }} onPointerDown={(e) => e.stopPropagation()} onClick={() => pickAsset(a.name)} style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 10px", border: "none", background: "transparent", color: t.text, fontSize: 12, cursor: "pointer", textAlign: "left" }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bg)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                                <span style={{ width: 18, height: 18, borderRadius: 5, background: ACCENT_BG, color: ACCENT, display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700 }}>
                                    {a.kind === "character" ? "角" : a.kind === "scene" ? "景" : "道"}
                                </span>
                                <span style={{ color: ACCENT, fontWeight: 600 }}>{a.name}</span>
                                <span style={{ color: t.faint, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{a.description}</span>
                            </button>
                            ))}
                            {!allAssets.some((a) => !atQuery || a.name.includes(atQuery)) ? <div style={{ padding: 8, fontSize: 11, color: t.faint }}>没有匹配的资产</div> : null}
                        </div>
                    ) : null}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
                        <span style={{ fontSize: 10, color: t.faint }}>输入 @ 选择资产,失焦自动保存</span>
                        <button type="button" onMouseDown={stop} onClick={() => { saveDesc(descEdit.shotId, descValue); setDescEdit(null); }} style={{ ...primaryBtn(t, { height: 24, padding: "0 10px", fontSize: 11 }) }}>
                            保存
                        </button>
                    </div>
                </div>
            ) : null}

            {/* ---------------- 操作 … 弹窗(颜色标注 / 删除) ---------------- */}
            {menuShot ? (
                <div style={{ position: "fixed", zIndex: 330, width: 180, borderRadius: 12, border: `1px solid ${t.border}`, background: t.panel, boxShadow: "0 16px 48px rgba(0,0,0,.3)", padding: 10 }} data-canvas-no-zoom>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 11, color: t.muted }}>标注颜色</span>
                        <button type="button" onMouseDown={stop} onClick={() => setMenuShot(null)} style={{ ...btn(t, { width: 20, height: 20, padding: 0, borderRadius: "50%", fontSize: 10 }) }}>✕</button>
                    </div>
                    <div style={{ display: "flex", gap: 8, padding: "2px 0 10px" }}>
                        {ROW_COLORS.map((color) => {
                            const shot = meta.shots.find((s) => s.id === menuShot);
                            const selected = shot?.rowColor === color;
                            return (
                                <button
                                    key={color || "default"}
                                    type="button"
                                    title={color ? `标注色 ${color}` : "默认(无背景)"}
                                    onMouseDown={stop}
                                    onClick={() => {
                                        updateShot(menuShot, { rowColor: color });
                                        setMenuShot(null);
                                    }}
                                    style={{
                                        width: 22,
                                        height: 22,
                                        borderRadius: "50%",
                                        cursor: "pointer",
                                        padding: 0,
                                        border: selected ? "2px solid #1c1917" : "2px solid rgba(120,113,108,.3)",
                                        background: color || t.bg,
                                        boxShadow: color ? `0 0 0 3px ${color}33` : "inset 0 0 0 1px rgba(120,113,108,.2)",
                                    }}
                                />
                            );
                        })}
                    </div>
                    <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
                        <button
                            type="button"
                            onMouseDown={stop}
                            onClick={() => {
                                const next = meta.shots.filter((s) => s.id !== menuShot).map((s, i) => ({ ...s, number: i + 1 }));
                                updateShots(next);
                                setMenuShot(null);
                            }}
                            style={{ ...btn(t, { width: "100%", color: "#ef4444", borderColor: "#ef444455" }) }}
                        >
                            🗑 删除该行
                        </button>
                    </div>
                </div>
            ) : null}

            {/* ---------------- Step3 提示词弹窗 ---------------- */}
            {promptShot ? (
                <div style={{ position: "fixed", inset: 0, zIndex: 340, display: "grid", placeItems: "center", background: "rgba(0,0,0,.45)" }} data-canvas-no-zoom onMouseDown={stop}>
                    <div style={{ width: 560, maxWidth: "90vw", borderRadius: 14, border: `1px solid ${t.border}`, background: t.panel, boxShadow: "0 24px 64px rgba(0,0,0,.35)", padding: 16 }} onMouseDown={stop}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                            <span style={{ fontSize: 14, fontWeight: 700 }}>
                                第{meta.shots.find((s) => s.id === promptShot)?.number}镜:最终提示词
                            </span>
                            <button type="button" onMouseDown={stop} onClick={() => setPromptShot(null)} style={{ ...btn(t, { width: 28, height: 28, padding: 0, borderRadius: "50%" }) }}>✕</button>
                        </div>
                        <label style={{ display: "block", fontSize: 11, color: t.muted, marginBottom: 4 }}>分镜提示词</label>
                        <textarea
                            value={promptOf(promptShot).prompt}
                            onChange={(e) => updatePrompt(promptShot, { prompt: e.target.value })}
                            rows={4}
                            style={{ ...inputStyle(t), resize: "vertical", lineHeight: 1.5, borderColor: ACCENT + "66" }}
                            onMouseDown={stop}
                            onPointerDown={stop}
                        />
                        <label style={{ display: "block", fontSize: 11, color: t.muted, margin: "10px 0 4px" }}>视频运动提示词</label>
                        <textarea
                            value={promptOf(promptShot).motionPrompt}
                            onChange={(e) => updatePrompt(promptShot, { motionPrompt: e.target.value })}
                            rows={3}
                            style={{ ...inputStyle(t), resize: "vertical", lineHeight: 1.5, borderColor: ACCENT + "66" }}
                            onMouseDown={stop}
                            onPointerDown={stop}
                        />
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                            <button type="button" onMouseDown={stop} onClick={() => setPromptShot(null)} style={primaryBtn(t)}>
                                完成
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 表格单元格
// ---------------------------------------------------------------------------
function Cell({ t, width, children, bg }: { t: T; width: number; children: React.ReactNode; bg?: string }) {
    return (
        <td style={{ padding: "6px 10px", borderBottom: `1px solid ${t.border}`, borderRight: `1px solid ${t.border}`, minWidth: width, maxWidth: width, fontSize: 12, verticalAlign: "top", background: bg }}>{children}</td>
    );
}

// 点击变输入框、失焦/回车提交的文本单元格
function EditableText({ t, value, editing, valueState, onStart, onValue, onCommit, bg }: { t: T; value: string; editing: boolean; valueState: string; onStart: () => void; onValue: (v: string) => void; onCommit: () => void; bg?: string }) {
    if (editing) {
        return (
            <input
                autoFocus
                value={valueState}
                onChange={(e) => onValue(e.target.value)}
                onBlur={onCommit}
                onKeyDown={(e) => e.key === "Enter" && onCommit()}
                onMouseDown={stop}
                onPointerDown={stop}
                style={inputStyle(t, { height: 24, padding: "0 6px", background: bg })}
            />
        );
    }
    return (
        <span style={{ cursor: "text", color: t.text, display: "block" }} onClick={onStart} title="点击编辑">
            {value || <span style={{ color: t.faint }}>—</span>}
        </span>
    );
}

// Step3 最终提示词列单元格
function PromptCell({ t, done, onClick }: { t: T; done: boolean; onClick: () => void }) {
    if (done) {
        return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: ACCENT_DIM, fontWeight: 600 }}>
                ✓ 已生成
            </span>
        );
    }
    return (
        <button type="button" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onClick(); }} style={{ ...btn(t, { borderColor: ACCENT + "88", color: ACCENT, fontSize: 11, height: 24, padding: "0 10px", background: ACCENT_BG }) }}>
            待生成提示词
        </button>
    );
}
