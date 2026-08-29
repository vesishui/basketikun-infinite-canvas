// 分镜台节点:一整块分镜板,按时间顺序排列所有镜头(分镜格)。
// 每个镜头含:镜号 / 景别 / 运镜 / 画面描述 / 台词旁白 / 时长,并可 AI 生成该镜的分镜画面图。
// 交互:双击镜头格打开下方面板编辑该镜头;「一句话 AI 铺全板」把故事/脚本拆成 N 个镜头自动铺满。
// 所有镜头数据存在节点 metadata.shots 中(浅合并数组整体替换,持久化 + 可撤销)。
import { definePlugin, useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodePanelProps } from "@infinite-canvas/plugin-sdk";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"];
const CAMERA_MOVES = ["固定", "推", "拉", "摇", "移", "跟", "升降"];
const DEFAULT_DURATION = 3;
const DEFAULT_SHOT_SIZE = "中景";
const DEFAULT_CAMERA_MOVE = "固定";
const IMAGE_RATIO = "16:9"; // 电影感横构图;支持 auto / 9:16 / 16:9 / 1024x1024 等

// AI 生成分镜画面的风格前缀(拼在用户画面描述之前,保证各格风格统一)
const STORYBOARD_STYLE =
    "电影级分镜画面,专业布光,高细节,电影感构图,景深层次丰富。画面内容:";

// AI 铺板:让模型把故事拆成镜头,严格只回一个 JSON 数组
const BOARD_SYSTEM_PROMPT = `你是资深分镜师。请把用户给出的故事/脚本拆解成连续的分镜镜头。
每个镜头必须包含这些字段:
- description: 该镜头的画面描述,一段中文,写清楚画面内容、主体与情绪
- shotSize: 景别,取值只能从 ["远景","全景","中景","近景","特写"] 中选择一个
- cameraMove: 运镜,取值只能从 ["固定","推","拉","摇","移","跟","升降"] 中选择一个
- dialogue: 该镜头的台词或旁白,没有则为空字符串
- duration: 该镜头时长(秒),整数
严格只输出一个 JSON 数组(数组元素即镜头对象),不要输出任何解释文字、前后缀或 Markdown 代码块。`;

// ---------------------------------------------------------------------------
// 数据类型
// ---------------------------------------------------------------------------

type Shot = {
    id: string;
    number: number; // 镜号(展示用,随增删自动重排)
    shotSize: string;
    cameraMove: string;
    description: string;
    dialogue: string;
    duration: number;
    image?: string; // 分镜画面图(dataURL,由 AI 生成)
};

function newShot(number: number): Shot {
    return {
        id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        number,
        shotSize: DEFAULT_SHOT_SIZE,
        cameraMove: DEFAULT_CAMERA_MOVE,
        description: "",
        dialogue: "",
        duration: DEFAULT_DURATION,
    };
}

function readShots(node: CanvasNodeContext["node"]): Shot[] {
    const shots = node.metadata?.shots;
    return Array.isArray(shots) ? (shots as Shot[]) : [];
}

// 重新按数组顺序给每格编号(删除/排序后调用)
function renumber(shots: Shot[]): Shot[] {
    return shots.map((shot, index) => ({ ...shot, number: index + 1 }));
}

// 通用小按钮
const iconBtn = (theme: CanvasNodeContext["theme"]) =>
    ({
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        height: 26,
        padding: "0 10px",
        borderRadius: 8,
        border: `1px solid ${theme.node.stroke}`,
        background: theme.toolbar.panel,
        color: theme.node.text,
        fontSize: 12,
        cursor: "pointer",
        userSelect: "none",
    }) as const;

// ---------------------------------------------------------------------------
// 内容:分镜板(节点主体)
// ---------------------------------------------------------------------------

function BoardContent({ ctx }: CanvasNodeContentProps) {
    const theme = ctx.theme;
    const shots = readShots(ctx.node);
    const [generating, setGenerating] = useState<Record<string, boolean>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    // 异步回调里读最新 shots,避免闭包拿到旧数组覆盖新改动
    const shotsRef = useRef(shots);
    useEffect(() => {
        shotsRef.current = shots;
    }, [shots]);

    const persist = useCallback((next: Shot[]) => ctx.updateMetadata({ shots: next }), [ctx]);
    const updateShot = useCallback(
        (id: string, patch: Partial<Shot>) => {
            persist(shotsRef.current.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)));
        },
        [persist],
    );
    const addShot = useCallback(() => {
        const next = renumber([...shotsRef.current, newShot(shotsRef.current.length + 1)]);
        persist(next);
    }, [persist]);
    const removeShot = useCallback(
        (id: string) => {
            persist(renumber(shotsRef.current.filter((shot) => shot.id !== id)));
        },
        [persist],
    );
    const moveShot = useCallback(
        (id: string, dir: -1 | 1) => {
            const list = [...shotsRef.current];
            const index = list.findIndex((shot) => shot.id === id);
            const target = index + dir;
            if (index < 0 || target < 0 || target >= list.length) return;
            [list[index], list[target]] = [list[target], list[index]];
            persist(renumber(list));
        },
        [persist],
    );

    // 双击镜头格 / 点「编辑」→ 记录要编辑的镜号并打开下方面板
    const openShotEditor = useCallback(
        (id: string) => {
            ctx.updateMetadata({ editingShotId: id });
            ctx.openPanel();
        },
        [ctx],
    );

    // AI 生成某镜的画面图,结果写回该格 metadata.shots[].image
    const generateShotImage = useCallback(
        async (id: string) => {
            const shot = shotsRef.current.find((item) => item.id === id);
            if (!shot) return;
            if (!shot.description.trim()) {
                setErrors((prev) => ({ ...prev, [id]: "请先填写画面描述" }));
                return;
            }
            setErrors((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
            });
            setGenerating((prev) => ({ ...prev, [id]: true }));
            try {
                const { images } = await ctx.ai.generateImage(STORYBOARD_STYLE + shot.description.trim(), { size: IMAGE_RATIO });
                const image = images[0];
                if (image) updateShot(id, { image });
            } catch (err) {
                setErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : "生成失败,请检查 AI 配置" }));
            } finally {
                setGenerating((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        },
        [ctx, updateShot],
    );

    const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
    const totalDuration = shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
    const boardTitle = (ctx.node.title || "分镜台").trim();

    return (
        <div data-canvas-no-zoom style={{ position: "relative", height: "100%", width: "100%", display: "flex", flexDirection: "column", overflow: "hidden", boxSizing: "border-box" }}>
            {/* 板头:标题 + 统计 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${theme.node.stroke}`, flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: theme.node.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>🎬 {boardTitle}</span>
                <span style={{ fontSize: 11, color: theme.node.placeholder, whiteSpace: "nowrap" }}>
                    {shots.length} 镜 · 共 {totalDuration}s
                </span>
            </div>

            {/* 镜头网格 */}
            {shots.length ? (
                <div style={{ flex: 1, overflow: "auto", padding: 10, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))", gap: 10, alignContent: "start" }}>
                    {shots.map((shot) => {
                        const isGenerating = generating[shot.id];
                        const error = errors[shot.id];
                        const tag = { fontSize: 10, lineHeight: 1, padding: "3px 6px", borderRadius: 6, border: `1px solid ${theme.node.stroke}`, color: theme.node.muted, background: "transparent", maxWidth: 52, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
                        return (
                            <div
                                key={shot.id}
                                onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    openShotEditor(shot.id);
                                }}
                                onMouseDown={stop}
                                style={{ position: "relative", display: "flex", flexDirection: "column", borderRadius: 10, border: `1px solid ${theme.node.stroke}`, background: theme.node.fill, overflow: "hidden", cursor: "pointer" }}
                            >
                                {/* 镜头头:镜号 + 标签 + 操作 */}
                                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 6px", borderBottom: `1px solid ${theme.node.stroke}` }}>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: theme.node.text, minWidth: 18 }}>{String(shot.number).padStart(2, "0")}</span>
                                    <span style={tag}>{shot.shotSize}</span>
                                    <span style={tag}>{shot.cameraMove}</span>
                                    <span style={{ flex: 1 }} />
                                    <span style={{ display: "flex", gap: 2 }}>
                                        <button type="button" title="上移" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); moveShot(shot.id, -1); }} style={{ ...iconBtn(theme), height: 20, padding: "0 6px", fontSize: 11 }} disabled={shot.number <= 1}>
                                            ↑
                                        </button>
                                        <button type="button" title="下移" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); moveShot(shot.id, 1); }} style={{ ...iconBtn(theme), height: 20, padding: "0 6px", fontSize: 11 }} disabled={shot.number >= shots.length}>
                                            ↓
                                        </button>
                                        <button type="button" title="删除镜头" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); removeShot(shot.id); }} style={{ ...iconBtn(theme), height: 20, padding: "0 6px", fontSize: 11 }}>
                                            ✕
                                        </button>
                                    </span>
                                </div>

                                {/* 画面区 */}
                                <div style={{ position: "relative", aspectRatio: "16 / 9", background: theme.canvas.background, display: "grid", placeItems: "center", overflow: "hidden" }}>
                                    {shot.image ? (
                                        <>
                                            <img src={shot.image} alt={`分镜${shot.number}`} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", pointerEvents: "none" }} />
                                            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: "rgba(0,0,0,.45)" }} onMouseDown={stop}>
                                                <button type="button" title="重新生成画面" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); void generateShotImage(shot.id); }} style={{ ...iconBtn(theme), background: "rgba(255,255,255,.92)", border: "none", color: "#1c1917", height: 24, padding: "0 8px" }}>
                                                    {isGenerating ? "生成中…" : "🔄 重生成"}
                                                </button>
                                            </div>
                                        </>
                                    ) : (
                                        <button type="button" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); void generateShotImage(shot.id); }} style={{ border: `1px dashed ${theme.node.stroke}`, background: "transparent", color: theme.node.placeholder, fontSize: 12, padding: "8px 12px", borderRadius: 8, cursor: "pointer" }}>
                                            {isGenerating ? "⏳ 生成中…" : "🎨 生成画面"}
                                        </button>
                                    )}
                                </div>

                                {/* 描述 + 台词 + 时长 */}
                                <div style={{ padding: "6px 8px 7px", display: "flex", flexDirection: "column", gap: 3 }}>
                                    <div style={{ fontSize: 11, lineHeight: 1.45, color: theme.node.text, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "2em" }}>
                                        {shot.description || <span style={{ color: theme.node.placeholder }}>双击填写画面描述</span>}
                                    </div>
                                    <div style={{ fontSize: 10, lineHeight: 1.4, color: theme.node.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {shot.dialogue ? `💬 ${shot.dialogue}` : ""}
                                    </div>
                                    <div style={{ fontSize: 10, color: theme.node.placeholder }}>
                                        ⏱ {shot.duration || 0}s
                                        {error ? <span style={{ color: "#ef4444", marginLeft: 6 }} title={error}>{error.length > 14 ? `${error.slice(0, 14)}…` : error}</span> : null}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: theme.node.placeholder, padding: 16, textAlign: "center" }}>
                    <span style={{ fontSize: 26 }}>🎬</span>
                    <span style={{ fontSize: 12 }}>还没有镜头。点「+ 镜头」手动添加,或用「AI 铺板」一句话生成整块分镜板。</span>
                    <span style={{ display: "flex", gap: 8 }} onMouseDown={stop}>
                        <button type="button" style={iconBtn(theme)} onClick={addShot}>+ 镜头</button>
                        <button type="button" style={{ ...iconBtn(theme), border: "none", background: theme.toolbar.activeBg, color: theme.toolbar.activeText }} onClick={() => { ctx.updateMetadata({ editingShotId: "" }); ctx.openPanel(); }}>
                            ✨ AI 铺板
                        </button>
                    </span>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 面板:Inspector 表单(编辑镜头 / 添加镜头 / AI 铺板)
// ---------------------------------------------------------------------------

function BoardPanel({ ctx, onClose }: CanvasNodePanelProps) {
    const theme = ctx.theme;
    const shots = readShots(ctx.node);
    // 当前正在编辑的镜头 id;metadata.editingShotId 为空串表示「新建镜头」,缺省/null 表示未进入编辑
    const editingId = ctx.node.metadata?.editingShotId as string | undefined;
    const editingShot = typeof editingId === "string" && editingId !== "" ? shots.find((shot) => shot.id === editingId) : undefined;
    const isNew = editingId === "";

    // 本地草稿(未点保存不入库)
    const [draft, setDraft] = useState<Shot | null>(() => (editingShot ? { ...editingShot } : isNew ? newShot(shots.length + 1) : null));

    const [aiOpen, setAiOpen] = useState(false);
    const [aiStory, setAiStory] = useState("");
    const [aiCount, setAiCount] = useState(6);
    const [aiBusy, setAiBusy] = useState(false);
    const [aiError, setAiError] = useState("");

    // 切到别的镜头时同步草稿
    useEffect(() => {
        setDraft(editingShot ? { ...editingShot } : isNew ? newShot(shots.length + 1) : null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingId]);

    const persist = useCallback((next: Shot[]) => ctx.updateMetadata({ shots: next }), [ctx]);

    const saveDraft = () => {
        if (!draft) return;
        const next = shots.some((shot) => shot.id === draft.id)
            ? shots.map((shot) => (shot.id === draft.id ? draft : shot))
            : renumber([...shots, draft]);
        persist(next);
        ctx.updateMetadata({ editingShotId: undefined });
        onClose();
    };

    const startNew = () => {
        ctx.updateMetadata({ editingShotId: "" });
    };

    const startEdit = (id: string) => {
        ctx.updateMetadata({ editingShotId: id });
    };

    // AI 铺板:generateText → 严格 JSON 数组 → 覆盖当前分镜板
    const runAiBoard = async () => {
        const story = aiStory.trim();
        if (!story) {
            setAiError("请先输入故事或脚本");
            return;
        }
        const count = Math.max(1, Math.min(40, Number(aiCount) || 6));
        setAiBusy(true);
        setAiError("");
        try {
            const { text } = await ctx.ai.generateText(`请把这个故事拆成 ${count} 个分镜镜头:\n${story}`, {
                system: BOARD_SYSTEM_PROMPT,
            });
            const parsed = parseAiBoard(text);
            if (!parsed.length) {
                setAiError("AI 没有返回有效的镜头列表,请重试或精简故事");
                return;
            }
            persist(
                renumber(
                    parsed.map((raw, index) => ({
                        id: newShot(index + 1).id,
                        number: index + 1,
                        shotSize: raw.shotSize,
                        cameraMove: raw.cameraMove,
                        description: raw.description,
                        dialogue: raw.dialogue,
                        duration: raw.duration,
                    })),
                ),
            );
            setAiOpen(false);
        } catch (err) {
            setAiError(err instanceof Error ? err.message : "AI 铺板失败,请检查 AI 配置");
        } finally {
            setAiBusy(false);
        }
    };

    const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
    const inputStyle = {
        width: "100%",
        boxSizing: "border-box" as const,
        borderRadius: 8,
        border: `1px solid ${theme.node.stroke}`,
        background: theme.node.fill,
        color: theme.node.text,
        padding: "6px 10px",
        fontSize: 13,
        outline: "none",
    };
    const labelStyle = { display: "block", fontSize: 11, color: theme.node.muted, margin: "8px 0 4px" } as const;
    const selectStyle = { ...inputStyle, height: 32, cursor: "pointer" };

    return (
        <div
            data-canvas-no-zoom
            onMouseDown={stop}
            onPointerDown={stop}
            onWheel={(e) => e.stopPropagation()}
            style={{ borderRadius: 14, border: `1px solid ${theme.toolbar.border}`, background: theme.toolbar.panel, boxShadow: "0 12px 40px rgba(0,0,0,.22)", padding: 14, color: theme.node.text, maxHeight: "60dvh", overflow: "auto" }}
        >
            {/* 顶部操作区 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <button type="button" style={iconBtn(theme)} onClick={startNew}>+ 添加镜头</button>
                <button type="button" style={{ ...iconBtn(theme), border: "none", background: theme.toolbar.activeBg, color: theme.toolbar.activeText }} onClick={() => setAiOpen((v) => !v)}>
                    ✨ AI 铺板
                </button>
                <span style={{ flex: 1 }} />
                <button type="button" title="关闭面板" style={iconBtn(theme)} onClick={onClose}>✕</button>
            </div>

            {/* 镜头快速切换(已存在的镜头) */}
            {shots.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                    {shots.map((shot) => (
                        <button
                            key={shot.id}
                            type="button"
                            onClick={() => startEdit(shot.id)}
                            style={{
                                ...iconBtn(theme),
                                height: 24,
                                padding: "0 8px",
                                fontSize: 11,
                                background: shot.id === editingId ? theme.toolbar.activeBg : theme.toolbar.panel,
                                color: shot.id === editingId ? theme.toolbar.activeText : theme.node.text,
                                border: shot.id === editingId ? `1px solid ${theme.toolbar.activeBg}` : `1px solid ${theme.node.stroke}`,
                            }}
                        >
                            {shot.number}
                        </button>
                    ))}
                </div>
            ) : null}

            {/* 镜头编辑表单 */}
            {draft ? (
                <div style={{ borderTop: `1px solid ${theme.toolbar.border}`, paddingTop: 10 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 88px", gap: 8 }}>
                        <div>
                            <label style={labelStyle}>景别</label>
                            <select value={draft.shotSize} onChange={(e) => setDraft({ ...draft, shotSize: e.target.value })} style={selectStyle}>
                                {SHOT_SIZES.map((size) => (
                                    <option key={size} value={size}>{size}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label style={labelStyle}>运镜</label>
                            <select value={draft.cameraMove} onChange={(e) => setDraft({ ...draft, cameraMove: e.target.value })} style={selectStyle}>
                                {CAMERA_MOVES.map((move) => (
                                    <option key={move} value={move}>{move}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label style={labelStyle}>时长(秒)</label>
                            <input type="number" min={0} step={1} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: Math.max(0, Number(e.target.value) || 0) })} style={inputStyle} />
                        </div>
                    </div>
                    <label style={labelStyle}>画面描述(也是 AI 生图提示词)</label>
                    <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={3} placeholder="例如:雨夜,主角撑着伞走过霓虹街角,回眸一笑" style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
                    <label style={labelStyle}>台词 / 旁白</label>
                    <textarea value={draft.dialogue} onChange={(e) => setDraft({ ...draft, dialogue: e.target.value })} rows={2} placeholder="该镜头的台词或旁白(可留空)" style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button type="button" style={{ ...iconBtn(theme), border: "none", background: theme.toolbar.activeBg, color: theme.toolbar.activeText }} onClick={saveDraft}>
                            保存镜头
                        </button>
                        <button type="button" style={iconBtn(theme)} onClick={() => { ctx.updateMetadata({ editingShotId: undefined }); setDraft(null); }}>
                            取消
                        </button>
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: 11, color: theme.node.placeholder, alignSelf: "center" }}>{draft.number} 号镜头</span>
                    </div>
                </div>
            ) : !aiOpen ? (
                <div style={{ fontSize: 12, color: theme.node.placeholder, padding: "6px 0" }}>
                    双击画布上的镜头格可编辑该镜头;点「+ 添加镜头」新建;点「AI 铺板」一句话生成整块分镜板。
                </div>
            ) : null}

            {/* AI 铺板表单 */}
            {aiOpen ? (
                <div style={{ borderTop: `1px solid ${theme.toolbar.border}`, paddingTop: 10 }}>
                    <label style={labelStyle}>故事 / 脚本(一句话即可)</label>
                    <textarea value={aiStory} onChange={(e) => setAiStory(e.target.value)} rows={4} placeholder="例如:一个少年在废弃游乐园里找到一台能穿越时间的老式相机,他拍下第一张照片后回到了十年前的那个夏天" style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <label style={{ ...labelStyle, margin: 0 }}>镜头数</label>
                        <input type="number" min={1} max={40} value={aiCount} onChange={(e) => setAiCount(Number(e.target.value) || 1)} style={{ ...inputStyle, width: 72, height: 30 }} />
                        <span style={{ flex: 1 }} />
                        <button type="button" disabled={aiBusy} style={{ ...iconBtn(theme), border: "none", background: theme.toolbar.activeBg, color: theme.toolbar.activeText }} onClick={() => void runAiBoard()}>
                            {aiBusy ? "⏳ 拆分中…" : "🪄 生成分镜板"}
                        </button>
                    </div>
                    {aiError ? <div style={{ fontSize: 11, color: "#ef4444", marginTop: 8 }}>{aiError}</div> : null}
                </div>
            ) : null}
        </div>
    );
}

// 解析 AI 返回的文本为镜头数组(容忍被 Markdown 代码块包裹 / 多余前后文)
function parseAiBoard(text: string): Array<{ shotSize: string; cameraMove: string; description: string; dialogue: string; duration: number }> {
    let raw = text.trim();
    // 去掉可能的 ```json ... ``` 包裹
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();
    // 只截取最外层的 JSON 数组部分
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item) => item && typeof item === "object")
            .map((item) => ({
                shotSize: SHOT_SIZES.includes(item.shotSize) ? item.shotSize : DEFAULT_SHOT_SIZE,
                cameraMove: CAMERA_MOVES.includes(item.cameraMove) ? item.cameraMove : DEFAULT_CAMERA_MOVE,
                description: String(item.description || "").trim(),
                dialogue: String(item.dialogue || "").trim(),
                duration: Math.max(0, Number(item.duration) || DEFAULT_DURATION),
            }))
            .filter((item) => item.description);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// 插件导出
// ---------------------------------------------------------------------------

export default definePlugin({
    id: "storyboard-board",
    name: "分镜台",
    version: "1.0.0",
    description: "一整块视频分镜板:多镜头网格、AI 生成每格画面、一句话自动铺全板",
    nodes: [
        {
            type: "storyboard-board:board",
            title: "分镜台",
            icon: "🎬",
            description: "视频分镜板(多镜头 / AI 生图 / 一句话铺板)",
            defaultSize: { width: 640, height: 400 },
            defaultMetadata: { shots: [] },
            minimapColor: "#e11d48",
            // 作为上游被消费时,输出整块分镜板文本(镜号/景别/运镜/描述/台词/时长)
            resource: (node) => {
                const shots = readShots(node);
                if (!shots.length) return null;
                const text = shots
                    .map((shot, index) => {
                        const line = `[${index + 1}] ${shot.shotSize} · ${shot.cameraMove} · ${shot.duration}s`;
                        return `${line}\n画面:${shot.description || "-"}\n台词:${shot.dialogue || "-"}`;
                    })
                    .join("\n\n");
                return { kind: "text", text: `分镜台「${node.title || ""}」\n${text}` };
            },
            Content: BoardContent,
            Panel: BoardPanel,
            // 工具条:添加镜头 + 打开面板(AI 铺板 / 编辑)
            toolbar: (ctx) => [
                {
                    id: "storyboard-add",
                    title: "添加一个镜头",
                    label: "+ 镜头",
                    icon: "＋",
                    onClick: () => {
                        const shots = readShots(ctx.node);
                        ctx.updateMetadata({ shots: renumber([...shots, newShot(shots.length + 1)]) });
                    },
                },
                {
                    id: "storyboard-panel",
                    title: "打开分镜台面板(编辑镜头 / AI 铺板)",
                    label: "面板",
                    icon: "🪄",
                    onClick: () => ctx.openPanel(),
                },
            ],
        },
    ],
});
