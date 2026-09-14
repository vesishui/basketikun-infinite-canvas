// 抠图工作台 v6：SAM 点选/一键分层 → 透明层落画布做动画；分层重绘复用宿主「局部遮罩编辑」契约，模型由用户在画布上自选。
// 为什么不再烧数字角标：宿主局部重绘认的是「原图 + 蓝色半透明标注区域」，数字角标模型读不懂；SAM 已算出精确 mask，直接把 mask 接进画布现成链路即可。
import { definePlugin, useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasAgentOp, CanvasNodeContentProps, CanvasNodePanelProps, CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

// 运行时和权重一律本地托管：插件此前直连 cdn.jsdelivr 拉 transformers.js，断网/代理没开就整个插件不可用，与「本地优先」矛盾。
// 产物由 scripts/fetch-runtime.sh 放进 web/public/vendor，权重放进 web/public/models。
const TF_URL = "/vendor/transformers.min.js";
// wasm 必须和 transformers.min.js 同目录：该产物用 import.meta.url 推导 publicPath，跨目录会 404
const WASM_PATH = "/vendor/";

const MODEL_DIR = "Xenova/slimsam-77-uniform";
const MODEL_PATH = `/models/${MODEL_DIR}/`;
// 与宿主 canvas-node-mask-edit-dialog 的 maskOverlayColor(#2563eb) / maskOverlayAlpha(0.4) 保持一致
const MASK_RGB: [number, number, number] = [37, 99, 235];
const MASK_ALPHA = 0.4;
// 与宿主 i18n canvas.projectPage.maskPrompt 模板一致：图片1=原图，图片2=标注图（前缀由宿主按入边顺序自动编号）
const MASK_PROMPT = "参考图片1为原图，图片2是在原图上用蓝色半透明标注出的待修改区域。请只修改蓝色标注覆盖的区域，其余区域与原图保持完全一致，输出与原图相同尺寸的完整图片，并且结果中不要保留任何蓝色标注。修改要求：";

async function ensureStatic(url: string, script: string) {
    const res = await fetch(url);
    if ((res.headers.get("content-type") || "").includes("html")) throw new Error(`本地资源未托管：${url} 被回落成 HTML，请跑 ${script} 复制到 web/public`);
}

let tfPromise: Promise<any> | null = null;
function loadTf(): Promise<any> {
    if (!tfPromise) tfPromise = import(TF_URL).catch((e) => { tfPromise = null; throw e; });
    return tfPromise;
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片读取失败"));
        img.src = src;
    });
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Pin = { id: number; x: number; y: number; mask?: number[][]; status: "idle" | "loading" | "ok" | "error" };
let pinSeq = 1;

function sourceOf(ctx: CanvasNodeContext) {
    const node = ctx.getUpstream().find((n) => n.type === "image" && n.metadata?.content);
    if (!node) return null;
    return { id: node.id, url: node.metadata!.content as string, width: node.width, height: node.height };
}

function bboxOf(masks: number[][][]): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (const m of masks) for (let y = 0; y < m.length; y++) { const row = m[y]; for (let x = 0; x < row.length; x++) if (row[x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 < 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    return { x0, y0, x1, y1 };
}

function unionMask(masks: number[][][], fh: number, fw: number): number[][] {
    const out: number[][] = [];
    for (let y = 0; y < fh; y++) { const row: number[] = new Array(fw).fill(0); for (const m of masks) { const r = m[y]; if (r) for (let x = 0; x < fw; x++) if (r[x]) row[x] = 1; } out.push(row); }
    return out;
}

function maskRatio(mask: number[][], fh: number, fw: number) {
    let hit = 0;
    for (let y = 0; y < mask.length; y++) { const row = mask[y]; for (let x = 0; x < row.length; x++) if (row[x]) hit++; }
    return hit / Math.max(1, fh * fw);
}

function maskIou(a: number[][], b: number[][]) {
    let inter = 0, uni = 0;
    for (let y = 0; y < a.length; y++) { const ra = a[y], rb = b[y]; if (!rb) continue; for (let x = 0; x < ra.length; x++) { const va = ra[x], vb = rb[x]; if (va && vb) inter++; if (va || vb) uni++; } }
    return uni ? inter / uni : 0;
}

async function toBase(img: HTMLImageElement, fw: number, fh: number): Promise<ImageData> {
    const c = document.createElement("canvas"); c.width = fw; c.height = fh;
    const ctx2 = c.getContext("2d", { willReadFrequently: true })!;
    ctx2.drawImage(img, 0, 0);
    return ctx2.getImageData(0, 0, fw, fh);
}

// SAM 出来的是硬二值边，直接透明化会留明显锯齿。实测过 trimap matting 精修（ViTMatte）
// 但结果比原 mask 更差（MSE 0.003 → 0.009，且基本无视 trimap 带宽），所以这里只做确定性羽化。
// 可分离盒模糊，镜像边界，避免贴边对象在画框处被削出一圈半透明。
const mirror = (i: number, n: number) => (n < 2 ? 0 : i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);

function feather(mask: number[][], fw: number, fh: number, r: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(fw * fh);
    const span = 2 * r + 1;
    if (r <= 0) { for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) out[y * fw + x] = mask[y][x] ? 255 : 0; return out; }
    const tmp = new Float32Array(fw * fh);
    for (let y = 0; y < fh; y++) {
        const row = mask[y]; let sum = 0;
        for (let d = -r; d <= r; d++) sum += row[mirror(d, fw)] ? 1 : 0;
        for (let x = 0; x < fw; x++) {
            tmp[y * fw + x] = sum / span;
            sum += row[mirror(x + r + 1, fw)] ? 1 : 0;
            sum -= row[mirror(x - r, fw)] ? 1 : 0;
        }
    }
    for (let x = 0; x < fw; x++) {
        let sum = 0;
        for (let d = -r; d <= r; d++) sum += tmp[mirror(d, fh) * fw + x];
        for (let y = 0; y < fh; y++) {
            out[y * fw + x] = Math.round(255 * sum / span);
            sum += tmp[mirror(y + r + 1, fh) * fw + x] - tmp[mirror(y - r, fh) * fw + x];
        }
    }
    return out;
}

// 源图按软 alpha 裁出透明 PNG（分层做动画用）
async function maskedDataUrl(base: ImageData, fw: number, fh: number, alpha: Uint8ClampedArray, bbox: { x0: number; y0: number; x1: number; y1: number }, pad = 8): Promise<string> {
    const tmp = document.createElement("canvas"); tmp.width = fw; tmp.height = fh;
    const tc = tmp.getContext("2d", { willReadFrequently: true })!;
    tc.putImageData(base, 0, 0);
    const frame = tc.getImageData(0, 0, fw, fh);
    const d = frame.data;
    for (let i = 0, n = fw * fh; i < n; i++) d[i * 4 + 3] = alpha[i];
    tc.putImageData(frame, 0, 0);
    const cx = Math.max(0, bbox.x0 - pad), cy = Math.max(0, bbox.y0 - pad);
    const cw = Math.min(fw - cx, bbox.x1 - bbox.x0 + 1 + pad * 2 - (bbox.x0 - cx));
    const ch = Math.min(fh - cy, bbox.y1 - bbox.y0 + 1 + pad * 2 - (bbox.y0 - cy));
    const out = document.createElement("canvas"); out.width = Math.max(1, cw); out.height = Math.max(1, ch);
    out.getContext("2d")!.drawImage(tmp, cx, cy, cw, ch, 0, 0, cw, ch);
    return out.toDataURL("image/png");
}

// 复刻宿主 buildMaskOverlay：原图 + mask 区域 #2563eb 半透明，供画布局部重绘识别
async function maskOverlayDataUrl(base: ImageData, fw: number, fh: number, mask: number[][]): Promise<string> {
    const tint = document.createElement("canvas"); tint.width = fw; tint.height = fh;
    const tctx = tint.getContext("2d")!;
    const tid = tctx.createImageData(fw, fh);
    for (let y = 0; y < fh; y++) { const row = mask[y]; if (!row) continue; for (let x = 0; x < fw; x++) if (row[x]) { const i = (y * fw + x) * 4; tid.data[i] = MASK_RGB[0]; tid.data[i + 1] = MASK_RGB[1]; tid.data[i + 2] = MASK_RGB[2]; tid.data[i + 3] = 255; } }
    tctx.putImageData(tid, 0, 0);
    const out = document.createElement("canvas"); out.width = fw; out.height = fh;
    const c = out.getContext("2d")!;
    c.putImageData(base, 0, 0);
    c.globalAlpha = MASK_ALPHA;
    c.drawImage(tint, 0, 0);
    return out.toDataURL("image/png");
}

// "@1 换金属材质，@2 去掉背景" → Map{1:[...], 2:[...]}；key 0 = 没挂角标的整体要求
function parseRefs(text: string): Map<number, string[]> {
    const map = new Map<number, string[]>();
    const push = (key: number, chunk: string) => {
        const s = chunk.trim().replace(/^[，,、；;：:\s]+/, "").trim();
        if (!s) return;
        map.set(key, [...(map.get(key) ?? []), s]);
    };
    const re = /@(\d+)/g;
    let current = 0, last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) { push(current, text.slice(last, m.index)); current = Number(m[1]); last = m.index + m[0].length; }
    push(current, text.slice(last));
    return map;
}

// SAM 会话：全图特征只算一次，之后每次点选只跑 prompt encoder + mask decoder
type Sam = { tf: any; processor: any; model: any; raw: any; image_embeddings: any; image_positional_embeddings: any; key: string };

function WorkbenchContent({ ctx }: CanvasNodeContentProps) {
    const hasSource = Boolean(sourceOf(ctx));
    return (
        <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 12, boxSizing: "border-box", color: ctx.theme.node.text, textAlign: "center" }}>
            <div style={{ fontSize: 30 }}>✂️</div>
            <div style={{ fontSize: 13, color: hasSource ? ctx.theme.node.text : ctx.theme.node.placeholder, lineHeight: 1.5 }}>{hasSource ? "双击打开工作台抠图" : "把图片节点连到这里"}</div>
            <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => ctx.openPanel()} style={{ padding: "5px 14px", borderRadius: 8, border: "none", background: ctx.theme.toolbar.activeBg, color: ctx.theme.toolbar.activeText, cursor: "pointer", fontSize: 12 }}>打开工作台</button>
        </div>
    );
}

function WorkbenchPanel({ ctx, onClose }: CanvasNodePanelProps) {
    const sourceNode = sourceOf(ctx);
    const source = sourceNode?.url || "";
    const [pins, setPins] = useState<Pin[]>(() => (Array.isArray(ctx.node.metadata?.cutoutPins) ? (ctx.node.metadata!.cutoutPins as { x: number; y: number }[]).map((p) => ({ id: pinSeq++, x: p.x, y: p.y, status: "idle" as const })) : []));
    const [markMode, setMarkMode] = useState(true);
    const [featherR, setFeatherR] = useState(() => (typeof ctx.node.metadata?.cutoutFeather === "number" ? (ctx.node.metadata!.cutoutFeather as number) : 2));
    const [instruction, setInstruction] = useState("");
    const [modelStatus, setModelStatus] = useState("SAM 未加载（点角标时自动加载，首次约几百 MB 走缓存）");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const imgRef = useRef<HTMLImageElement | null>(null);
    const samRef = useRef<Sam | null>(null);
    // ctx 每次渲染都是新对象，绝不能进 effect 依赖（否则 updateMetadata→重渲染→新ctx→死循环）
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;

    useEffect(() => { if (!source) { setPins([]); samRef.current = null; } }, [source]);
    useEffect(() => { ctxRef.current.updateMetadata({ cutoutPins: pins.map((p) => ({ x: p.x, y: p.y })), cutoutFeather: featherR }); }, [pins, featherR]);

    const ensureSam = useCallback(async (): Promise<Sam> => {
        if (samRef.current && samRef.current.key === source) return samRef.current;
        try {
            // 先确认本地静态资源真的被托管：Vite 的 public 扫描遇到符号链接会整体放弃，
            // 此时 /models 与 /vendor 会静默回落到 index.html，只会报一句难懂的解析失败。
            await ensureStatic(`${MODEL_PATH}config.json`, "scripts/fetch-sam-model.sh");
            await ensureStatic(`${WASM_PATH}ort-wasm-simd-threaded.jsep.wasm`, "scripts/fetch-runtime.sh");
            const tf = await loadTf();
            tf.env.backends.onnx.wasm.wasmPaths = WASM_PATH;
            // 权重随项目放在 public/models 下本地托管：浏览器直连 hf-mirror 会 Failed to fetch，不走外网最稳
            tf.env.allowLocalModels = true;
            tf.env.localModelPath = "/models/";
            tf.env.allowRemoteModels = false;
            setModelStatus("加载 SAM 模型中…");
            const processor = await tf.SamProcessor.from_pretrained(MODEL_DIR);
            // 只用 WASM：同样的量化权重在 WebGPU 上分割结果完全错位（实测命中率 12%），且比 WASM 还慢
            const model = await tf.SamModel.from_pretrained(MODEL_DIR, { dtype: "q8" });
            const raw = await tf.RawImage.fromURL(source);
            // 全图特征只编码一次，prompt encoder + mask decoder 每点只跑一遍
            const { pixel_values } = await processor(raw);
            const { image_embeddings, image_positional_embeddings } = await model.get_image_embeddings({ pixel_values });
            samRef.current = { tf, processor, model, raw, image_embeddings, image_positional_embeddings, key: source };
            setModelStatus("SAM 就绪（WASM）· 点图加角标即分割");
            return samRef.current;
        } catch (e) {
            setModelStatus(`SAM 加载失败：${errText(e)}`);
            throw e;
        }
    }, [source]);

    const maskAt = useCallback(async (x: number, y: number): Promise<number[][]> => {
        const sam = await ensureSam();
        const img = imgRef.current; const fw = img?.naturalWidth || 0; const fh = img?.naturalHeight || 0;
        if (!fw || !fh) throw new Error("源图尺寸未就绪");
        const inputs = await sam.processor(sam.raw, { input_points: [[[x * fw, y * fh]]] });
        const { pred_masks, iou_scores } = await sam.model({ ...inputs, image_embeddings: sam.image_embeddings, image_positional_embeddings: sam.image_positional_embeddings });
        // 每个点返回 3 个候选 mask，取 iou 分数最高的那个
        const scores = iou_scores.data as Float32Array;
        let best = 0; for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
        // 官方后处理负责去 padding + 还原到原图尺寸，自己上采样会在非方图上错位
        const [masks] = await sam.processor.post_process_masks(pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
        const dims = masks.dims as number[]; const H = dims[dims.length - 2]; const W = dims[dims.length - 1];
        const data = masks.data as Uint8Array; const off = best * H * W;
        const mask: number[][] = [];
        for (let yy = 0; yy < H; yy++) { const row = new Array<number>(W); for (let xx = 0; xx < W; xx++) row[xx] = data[off + yy * W + xx] ? 1 : 0; mask.push(row); }
        return mask;
    }, [ensureSam]);

    const addPinAt = useCallback(async (clientX: number, clientY: number) => {
        const rect = imgRef.current?.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return;
        const x = clamp01((clientX - rect.left) / rect.width);
        const y = clamp01((clientY - rect.top) / rect.height);
        const id = pinSeq++;
        setPins((prev) => [...prev, { id, x, y, status: "loading" }]);
        try { const mask = await maskAt(x, y); setPins((prev) => prev.map((p) => (p.id === id ? { ...p, mask, status: "ok" } : p))); }
        catch (e) { setPins((prev) => prev.map((p) => (p.id === id ? { ...p, status: "error" } : p))); setError(errText(e)); }
    }, [maskAt]);

    const startDrag = useCallback((e: MouseEvent, id: number) => {
        e.stopPropagation(); e.preventDefault();
        const move = (ev: MouseEvent) => { const rect = imgRef.current?.getBoundingClientRect(); if (!rect) return; const x = clamp01((ev.clientX - rect.left) / rect.width); const y = clamp01((ev.clientY - rect.top) / rect.height); setPins((prev) => prev.map((p) => (p.id === id ? { ...p, x, y, mask: undefined, status: "idle" } : p))); };
        const up = (ev: MouseEvent) => {
            window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
            const rect = imgRef.current?.getBoundingClientRect(); if (!rect) return;
            const x = clamp01((ev.clientX - rect.left) / rect.width); const y = clamp01((ev.clientY - rect.top) / rect.height);
            void (async () => { try { const mask = await maskAt(x, y); setPins((prev) => prev.map((p) => (p.id === id ? { ...p, mask, status: "ok" } : p))); } catch (e) { setPins((prev) => prev.map((p) => (p.id === id ? { ...p, status: "error" } : p))); setError(errText(e)); } })();
        };
        window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    }, [maskAt]);

    // 一键分层：网格采样点自动分割，按面积过滤 + IoU 去重，得到多个对象层
    const autoLayer = useCallback(async () => {
        const img = imgRef.current; const fw = img?.naturalWidth || 0; const fh = img?.naturalHeight || 0;
        if (!fw || !fh) { setError("源图未就绪"); return; }
        setBusy(true); setError("");
        try {
            const found: Pin[] = [];
            let firstError: unknown = null;
            const step = 6;
            outer: for (let gy = 1; gy < step; gy++) for (let gx = 1; gx < step; gx++) {
                const x = gx / step, y = gy / step;
                let mask: number[][];
                try { mask = await maskAt(x, y); } catch (e) { firstError ??= e; continue; }
                const ratio = maskRatio(mask, fh, fw);
                if (ratio < 0.002 || ratio > 0.9) continue;
                if (found.some((p) => p.mask && maskIou(p.mask, mask) > 0.9)) continue;
                found.push({ id: pinSeq++, x, y, mask, status: "ok" });
                if (found.length >= 12) break outer;
            }
            setPins((prev) => [...prev, ...found]);
            // 采样全失败时把真实错误抛出来，否则会被误读成「识别不出对象」
            if (!found.length && firstError) throw firstError;
            if (!found.length) setError("没自动识别出可分层的对象，改用手动加角标");
        } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    }, [maskAt]);

    const appendRef = useCallback((num: number) => setInstruction((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}@${num} `), []);

    const addImageNode = (ops: CanvasAgentOp[], id: string, title: string, meta: Record<string, unknown>, x: number, y: number, w: number, h: number) => {
        ops.push({ type: "add_node", id, nodeType: "image", title, x, y, width: w, height: h, metadata: meta });
        ops.push({ type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: id });
    };

    const exportLayered = useCallback(async () => {
        const ready = pins.filter((p) => p.mask);
        if (!ready.length) { setError("先加角标或点「一键分层」，等分割完成"); return; }
        setBusy(true); setError("");
        try {
            const img = await loadImageEl(source); const fw = img.naturalWidth, fh = img.naturalHeight;
            const base = await toBase(img, fw, fh);
            const ops: CanvasAgentOp[] = []; const stamp = Date.now(); let y = ctx.node.position.y;
            for (let i = 0; i < ready.length; i++) {
                const m = ready[i].mask!; const bb = bboxOf([m]);
                const dataUrl = await maskedDataUrl(base, fw, fh, feather(m, fw, fh, featherR), bb, 8 + featherR);
                const di = await loadImageEl(dataUrl); const w = 240; const h = Math.max(40, Math.round((240 * di.naturalHeight) / Math.max(1, di.naturalWidth)));
                addImageNode(ops, `cutout-l-${stamp}-${i}`, `素材 ${i + 1}`, { content: dataUrl, mimeType: "image/png", status: "success" }, ctx.node.position.x + ctx.node.width + 90, y, w, h);
                y += h + 24;
            }
            ctx.applyOps(ops);
        } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    }, [pins, source, ctx]);

    const exportMerged = useCallback(async () => {
        const ready = pins.filter((p) => p.mask);
        if (!ready.length) { setError("先加角标或点「一键分层」，等分割完成"); return; }
        setBusy(true); setError("");
        try {
            const img = await loadImageEl(source); const fw = img.naturalWidth, fh = img.naturalHeight;
            const base = await toBase(img, fw, fh);
            const merged = unionMask(ready.map((p) => p.mask!), fh, fw);
            const dataUrl = await maskedDataUrl(base, fw, fh, feather(merged, fw, fh, featherR), bboxOf([merged]), 8 + featherR);
            const di = await loadImageEl(dataUrl); const w = 260; const h = Math.max(40, Math.round((260 * di.naturalHeight) / Math.max(1, di.naturalWidth)));
            const ops: CanvasAgentOp[] = []; addImageNode(ops, `cutout-m-${Date.now()}`, "抠图合并层", { content: dataUrl, mimeType: "image/png", status: "success" }, ctx.node.position.x + ctx.node.width + 90, ctx.node.position.y, w, h);
            ctx.applyOps(ops);
        } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    }, [pins, source, ctx]);

    // 发送到画布做局部重绘：落「遮罩标注图 + 结果节点」，结果节点入边顺序=原图→标注图（对应提示词里的图片1/图片2）
    const sendRedrawToCanvas = useCallback(async () => {
        if (!sourceNode) { setError("请先连入一个图片节点"); return; }
        const ready = pins.filter((p) => p.mask);
        if (!ready.length) { setError("先加角标或点「一键分层」，等分割完成"); return; }
        const text = instruction.trim();
        if (!text) { setError("先写修改要求，例如：@1 换成金属材质"); return; }
        setBusy(true); setError("");
        try {
            const img = await loadImageEl(sourceNode.url); const fw = img.naturalWidth, fh = img.naturalHeight;
            const base = await toBase(img, fw, fh);
            const refs = parseRefs(text);
            // 编号必须按界面上显示的 pins 序号，不能按过滤后的 ready 下标，否则中间层失败时会错位
            const plan: { mask: number[][]; prompt: string }[] = [];
            pins.forEach((p, i) => { if (!p.mask) return; const own = refs.get(i + 1); if (own) plan.push({ mask: p.mask, prompt: own.join("，") }); });
            if (!plan.length) {
                const whole = refs.get(0)?.join("，") || text;
                plan.push({ mask: unionMask(ready.map((p) => p.mask!), fh, fw), prompt: whole });
            }
            const ops: CanvasAgentOp[] = []; const stamp = Date.now();
            let y = ctx.node.position.y;
            for (let i = 0; i < plan.length; i++) {
                const overlay = await maskOverlayDataUrl(base, fw, fh, plan[i].mask);
                const maskId = `cutout-mask-${stamp}-${i}`; const resultId = `cutout-edit-${stamp}-${i}`;
                const x0 = ctx.node.position.x + ctx.node.width + 90;
                ops.push({ type: "add_node", id: maskId, nodeType: "image", title: `遮罩标注 ${i + 1}`, x: x0, y, width: sourceNode.width, height: sourceNode.height, metadata: { content: overlay, mimeType: "image/png", status: "success" } });
                ops.push({ type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: maskId });
                ops.push({ type: "add_node", id: resultId, nodeType: "image", title: plan[i].prompt.slice(0, 32), x: x0 + sourceNode.width + 90, y, width: sourceNode.width, height: sourceNode.height, metadata: { prompt: MASK_PROMPT + plan[i].prompt } });
                ops.push({ type: "connect_nodes", fromNodeId: sourceNode.id, toNodeId: resultId });
                ops.push({ type: "connect_nodes", fromNodeId: maskId, toNodeId: resultId });
                y += sourceNode.height + 40;
            }
            ctx.applyOps(ops);
            setInstruction("");
        } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    }, [pins, instruction, sourceNode, ctx]);

    const btn = (primary?: boolean) => ({ padding: "8px 14px", borderRadius: 8, border: primary ? "none" : `1px solid ${ctx.theme.toolbar.border}`, background: primary ? ctx.theme.toolbar.activeBg : "transparent", color: primary ? ctx.theme.toolbar.activeText : ctx.theme.node.text, cursor: "pointer" as const, fontSize: 13, opacity: busy ? 0.6 : 1 });

    return (
        <div data-canvas-no-zoom onMouseDown={(e) => e.stopPropagation()} style={{ width: "100%", height: "100%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div style={{ width: "min(1000px,95vw)", maxHeight: "90vh", display: "grid", gridTemplateColumns: "1fr 320px", background: ctx.theme.node.panel, color: ctx.theme.node.text, borderRadius: 16, overflow: "hidden", border: `1px solid ${ctx.theme.toolbar.border}` }}>
                <div style={{ background: ctx.theme.canvas.background, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 440, position: "relative", padding: 18 }}>
                    {source ? (
                        <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", maxHeight: "calc(90vh - 36px)", cursor: markMode ? "crosshair" : "default" }} onClick={(e) => { if (!markMode) return; if (imgRef.current && e.target !== imgRef.current) return; void addPinAt(e.clientX, e.clientY); }}>
                            <img ref={imgRef} src={source} alt="" style={{ display: "block", maxWidth: "100%", maxHeight: "calc(90vh - 36px)", objectFit: "contain" }} />
                            {pins.map((p, i) => (
                                <div key={p.id} onMouseDown={(e) => startDrag(e.nativeEvent as MouseEvent, p.id)} title={`图层 ${i + 1}（${p.status === "ok" ? "已分割" : p.status === "loading" ? "分割中" : p.status === "error" ? "失败" : "待分割"}；拖动重分，×删除）`} style={{ position: "absolute", left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: "translate(-50%,-50%)", width: 26, height: 26, borderRadius: "50%", background: p.status === "error" ? "rgba(239,68,68,0.92)" : p.status === "loading" ? "rgba(245,158,11,0.92)" : "rgba(47,111,237,0.92)", border: "2px solid #fff", color: "#fff", fontSize: 13, fontWeight: 700, textAlign: "center", lineHeight: "22px", cursor: "grab", userSelect: "none" }}>{i + 1}<span onClick={(e) => { e.stopPropagation(); setPins((prev) => prev.filter((q) => q.id !== p.id)); }} style={{ position: "absolute", right: -8, top: -8, width: 14, height: 14, borderRadius: "50%", background: "#ef4444", color: "#fff", fontSize: 10, lineHeight: "14px", textAlign: "center", cursor: "pointer" }}>×</span></div>
                            ))}
                        </div>
                    ) : (<span style={{ color: ctx.theme.node.placeholder, fontSize: 13 }}>未连入图片</span>)}
                </div>
                <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>抠图工作台 · 海报分层</div>
                    <div style={{ fontSize: 11, color: ctx.theme.node.faint, lineHeight: 1.5 }}>{modelStatus}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" style={{ ...btn(markMode), flex: 1, fontSize: 12 }} onClick={() => setMarkMode((v) => !v)}>{markMode ? "点图加层中…" : "加图层"}</button>
                        <button type="button" style={{ ...btn(), flex: 1, fontSize: 12 }} disabled={busy || !source} onClick={() => void autoLayer()}>一键分层</button>
                        <button type="button" style={{ ...btn(), fontSize: 12 }} disabled={!pins.length} onClick={() => setPins([])}>清空({pins.length})</button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: ctx.theme.node.muted }}>
                        <span>边缘羽化</span>
                        <input type="range" min={0} max={8} value={featherR} onChange={(e) => setFeatherR(Number(e.target.value))} style={{ flex: 1, accentColor: "#2563eb" }} />
                        <span style={{ width: 30, textAlign: "right" }}>{featherR}px</span>
                    </div>
                    <div style={{ fontSize: 12, color: ctx.theme.node.muted }}>透明图层（每个标记=一个可动图层）</div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" style={{ ...btn(), flex: 1, fontSize: 12 }} disabled={!pins.some((p) => p.mask) || busy} onClick={() => void exportLayered()}>分层导出</button>
                        <button type="button" style={{ ...btn(), flex: 1, fontSize: 12 }} disabled={!pins.some((p) => p.mask) || busy} onClick={() => void exportMerged()}>合并导出</button>
                    </div>
                    <div style={{ fontSize: 12, color: ctx.theme.node.muted, marginTop: 2 }}>修改要求（@数字 指代图层，不写@则改全部图层）</div>
                    <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="例如：@1 换金属材质，@2 去掉补背景" rows={3} style={{ resize: "none", borderRadius: 8, border: `1px solid ${ctx.theme.toolbar.border}`, background: "transparent", color: ctx.theme.node.text, fontSize: 13, padding: 8, lineHeight: 1.5, outline: "none" }} />
                    {pins.length ? (<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{pins.map((p, i) => (<button key={p.id} type="button" onClick={() => appendRef(i + 1)} style={{ width: 24, height: 24, borderRadius: "50%", border: `1px solid ${ctx.theme.toolbar.border}`, background: "transparent", color: ctx.theme.node.text, cursor: "pointer", fontSize: 12, padding: 0 }}>@{i + 1}</button>))}</div>) : null}
                    <button type="button" style={btn(true)} disabled={!pins.some((p) => p.mask) || busy} onClick={() => void sendRedrawToCanvas()}>发送画布（遮罩+提示词，不生成）</button>
                    {error ? <div style={{ fontSize: 12, color: "#ef4444", lineHeight: 1.5 }}>{error}</div> : null}
                    <div style={{ marginTop: "auto", fontSize: 11, color: ctx.theme.node.faint, lineHeight: 1.5 }}>发送后画布会落「遮罩标注图 → 结果节点」，走内置局部重绘：你在结果节点上选模型、点生成即可，插件不代跑。</div>
                    <button type="button" style={{ ...btn(), alignSelf: "flex-start" }} onClick={onClose}>关闭</button>
                </div>
            </div>
        </div>
    );
}

export default definePlugin({
    id: "cutout-studio",
    name: "抠图工作台",
    version: "0.6.4",
    description: "海报分层：一键/点选拆出透明图层做动画；遮罩+提示词接画布局部重绘，模型自选。",
    nodes: [
        {
            type: "cutout-studio:workbench",
            title: "抠图工作台",
            icon: "✂️",
            description: "连入图片，一键或点选分层，导出透明图层 / 发送遮罩重绘",
            defaultSize: { width: 300, height: 260 },
            fullscreenPanel: true,
            autoOpenPanel: false,
            onDoubleClick: (ctx) => { ctx.openPanel(); return true; },
            Content: WorkbenchContent,
            Panel: WorkbenchPanel,
        },
    ],
});
