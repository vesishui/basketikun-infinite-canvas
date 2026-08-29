// 脚本生成器插件 —— 通用 UI 辅助(全部跟随画布主题 token)
import { useCallback, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasTheme } from "@infinite-canvas/plugin-sdk";

import { ACCENT, ACCENT_BG, parseEntities } from "./mock";

// ---------------------------------------------------------------------------
// 主题便捷对象:把画布 theme token 摊平成常用字段,避免到处 ctx.theme.node.x
// ---------------------------------------------------------------------------
export function useT(theme: CanvasTheme) {
    return {
        bg: theme.node.fill,
        panel: theme.toolbar.panel,
        border: theme.node.stroke,
        text: theme.node.text,
        muted: theme.node.muted,
        faint: theme.node.placeholder,
        canvas: theme.canvas.background,
        activeBg: theme.toolbar.activeBg,
        activeText: theme.toolbar.activeText,
    };
}

export type T = ReturnType<typeof useT>;

// 小圆角按钮(扁平,遵循画布 UI 规范:无底色、hover 轻微反馈)
export const btn = (t: T, overrides: React.CSSProperties = {}): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 28,
    padding: "0 12px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: "transparent",
    color: t.text,
    fontSize: 12,
    lineHeight: 1,
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
    transition: "background .12s",
    ...overrides,
});

// 主色按钮(青色系强调)
export const primaryBtn = (t: T, overrides: React.CSSProperties = {}): React.CSSProperties => ({
    ...btn(t),
    border: "none",
    background: ACCENT,
    color: "#ffffff",
    fontWeight: 600,
    ...overrides,
});

// 置灰按钮
export const disabledBtn = (t: T): React.CSSProperties => ({
    ...btn(t),
    opacity: 0.4,
    cursor: "not-allowed",
});

// 文本输入框
export const inputStyle = (t: T, overrides: React.CSSProperties = {}): React.CSSProperties => ({
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.text,
    padding: "6px 10px",
    fontSize: 12,
    lineHeight: 1.5,
    outline: "none",
    ...overrides,
});

// 下拉框(原生 select 选项背景跟随系统,选中文字用主题色)
export const selectStyle = (t: T, overrides: React.CSSProperties = {}): React.CSSProperties => ({
    ...inputStyle(t),
    height: 28,
    width: "auto",
    cursor: "pointer",
    paddingRight: 6,
    ...overrides,
});

// ---------------------------------------------------------------------------
// 青色实体词高亮:把 description 里 [[实体]] 渲染成青色标签
// ---------------------------------------------------------------------------
export function HighlightText({ text, accent = ACCENT, accentBg = ACCENT_BG }: { text: string; accent?: string; accentBg?: string }) {
    const { text: clean, entities } = parseEntities(text);
    if (!entities.length) return <>{clean}</>;
    const parts: React.ReactNode[] = [];
    let rest = clean;
    let key = 0;
    for (const entity of entities) {
        const idx = rest.indexOf(entity);
        if (idx < 0) continue;
        if (idx > 0) parts.push(rest.slice(0, idx));
        parts.push(
            <span key={`${entity}-${key++}`} style={{ display: "inline-block", padding: "0 4px", margin: "0 1px", borderRadius: 5, background: accentBg, color: accent, fontSize: "0.92em", fontWeight: 600, whiteSpace: "nowrap" }}>
                {entity}
            </span>,
        );
        rest = rest.slice(idx + entity.length);
    }
    if (rest) parts.push(rest);
    return <>{parts}</>;
}

// ---------------------------------------------------------------------------
// 极简 toast(不依赖 antd,本期纯 mock)
// ---------------------------------------------------------------------------
export type ToastApi = { show: (msg: string) => void };

export function useToast(): { toast: ToastApi; toastNode: React.ReactNode } {
    const [msg, setMsg] = useState<string | null>(null);
    const timerRef = useRef<number | null>(null);
    useEffect(
        () => () => {
            if (timerRef.current) window.clearTimeout(timerRef.current);
        },
        [],
    );
    const show = useCallback((text: string) => {
        setMsg(text);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setMsg(null), 2200);
    }, []);
    const node = msg ? (
        <div
            data-canvas-no-zoom
            style={{
                position: "fixed",
                left: "50%",
                bottom: 48,
                transform: "translateX(-50%)",
                zIndex: 5000,
                padding: "9px 18px",
                borderRadius: 999,
                background: "rgba(28,25,23,.92)",
                color: "#fff",
                fontSize: 13,
                boxShadow: "0 8px 30px rgba(0,0,0,.35)",
                pointerEvents: "none",
            }}
        >
            {msg}
        </div>
    ) : null;
    return { toast: { show }, toastNode: node };
}

// ---------------------------------------------------------------------------
// 下拉选择(受控,选项数组)
// ---------------------------------------------------------------------------
export function Select({ value, options, onChange, t, style, title }: { value: string; options: string[]; onChange: (v: string) => void; t: T; style?: React.CSSProperties; title?: string }) {
    return (
        <select
            title={title}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            style={selectStyle(t, style)}
        >
            {options.map((opt) => (
                <option key={opt} value={opt}>
                    {opt}
                </option>
            ))}
        </select>
    );
}

// 阻止事件冒泡(避免触发节点拖拽/画布缩放)
export function stop(e: { stopPropagation: () => void }) {
    e.stopPropagation();
}
