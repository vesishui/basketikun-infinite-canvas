import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter, Grid2x2, Group, Ungroup } from "lucide-react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { nodeBounds, type NodeArrangeMode } from "@/lib/canvas/canvas-node-geometry";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

const SELECTION_PAD = 14;

export function CanvasSelectionToolbar({
    nodes,
    viewport,
    showToolbar,
    canGroup,
    canUngroup,
    onGroup,
    onUngroup,
    onArrange,
}: {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    showToolbar: boolean;
    canGroup: boolean;
    canUngroup: boolean;
    onGroup: () => void;
    onUngroup: () => void;
    onArrange?: (mode: NodeArrangeMode) => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [arrangeOpen, setArrangeOpen] = useState(false);
    const arrangeRef = useRef<HTMLDivElement | null>(null);

    // 排列菜单打开期间常驻:鼠标移开不关闭,点击菜单以外区域才收起
    useEffect(() => {
        if (!arrangeOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (arrangeRef.current?.contains(event.target as Node)) return;
            setArrangeOpen(false);
        };
        window.addEventListener("pointerdown", handlePointerDown, true);
        return () => window.removeEventListener("pointerdown", handlePointerDown, true);
    }, [arrangeOpen]);

    if (nodes.length < 2) return null;

    const bounds = nodeBounds(nodes);
    const left = viewport.x + bounds.left * viewport.k - SELECTION_PAD;
    const top = viewport.y + bounds.top * viewport.k - SELECTION_PAD;
    const width = (bounds.right - bounds.left) * viewport.k + SELECTION_PAD * 2;
    const height = (bounds.bottom - bounds.top) * viewport.k + SELECTION_PAD * 2;
    const showActions = showToolbar && (canGroup || canUngroup || Boolean(onArrange));

    return (
        <>
            <svg className="pointer-events-none absolute z-[65] overflow-visible" style={{ left, top, width, height }}>
                <rect
                    x={1}
                    y={1}
                    width={Math.max(width - 2, 0)}
                    height={Math.max(height - 2, 0)}
                    rx={16}
                    ry={16}
                    fill={theme.canvas.selectionFill}
                    stroke={theme.canvas.selectionStroke}
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    strokeDasharray="7 5"
                    strokeLinecap="round"
                />
            </svg>
            {showActions ? (
                <div
                    className="absolute z-[70] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border border-black/10 bg-white text-[15px] text-[#242529] shadow-[0_8px_28px_rgba(15,23,42,.12)]"
                    style={{ left: left + width / 2, top: top - 8 }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {onArrange ? (
                        <div className="relative" ref={arrangeRef}>
                            {/* Tooltip 只挂在图标按钮上,菜单打开时禁用,避免提示遮住下拉菜单 */}
                            <Tooltip title={t("canvas.nodeToolbar.arrangeSelected")} placement="top" mouseEnterDelay={0.2} open={arrangeOpen ? false : undefined} color="#ffffff" styles={{ root: { color: "#242529", boxShadow: "0 8px 24px rgba(15,23,42,.16)", fontSize: 13, fontWeight: 500 } }}>
                                <button type="button" className="group relative flex h-12 items-center px-1.5" onClick={() => setArrangeOpen((value) => !value)} aria-label={t("canvas.nodeToolbar.arrangeSelected")} aria-expanded={arrangeOpen}>
                                    <span className={`flex h-9 items-center justify-center rounded-lg px-2 transition group-hover:bg-[#f0f0f1] ${arrangeOpen ? "bg-[#eeeeef]" : ""}`}>
                                        <Grid2x2 className="size-4" />
                                    </span>
                                </button>
                            </Tooltip>
                            {arrangeOpen ? (
                                    <div
                                        className="absolute left-1/2 top-full z-[80] mt-1.5 min-w-36 -translate-x-1/2 rounded-xl border border-black/10 bg-white p-1 shadow-[0_8px_28px_rgba(15,23,42,.18)]"
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onPointerDown={(event) => event.stopPropagation()}
                                    >
                                        {[
                                            { mode: "grid" as const, label: t("canvas.nodeToolbar.arrangeGrid"), icon: <Grid2x2 className="size-4" /> },
                                            { mode: "vertical" as const, label: t("canvas.nodeToolbar.arrangeVertical"), icon: <AlignVerticalJustifyCenter className="size-4" /> },
                                            { mode: "horizontal" as const, label: t("canvas.nodeToolbar.arrangeHorizontal"), icon: <AlignHorizontalJustifyCenter className="size-4" /> },
                                        ].map((item) => (
                                            <button
                                                key={item.mode}
                                                type="button"
                                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[#242529] transition hover:bg-[#f0f0f1]"
                                                onClick={() => {
                                                    setArrangeOpen(false);
                                                    onArrange?.(item.mode);
                                                }}
                                            >
                                                {item.icon}
                                                <span>{item.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                    ) : null}
                    {canGroup ? <SelectionAction title={t("canvas.nodeToolbar.groupTitle")} label={t("canvas.nodeToolbar.group")} icon={<Group className="size-4" />} onClick={onGroup} /> : null}
                    {canUngroup ? <SelectionAction title={t("canvas.nodeToolbar.ungroupTitle")} label={t("canvas.nodeToolbar.ungroup")} icon={<Ungroup className="size-4" />} onClick={onUngroup} /> : null}
                </div>
            ) : null}
        </>
    );
}

function SelectionAction({ title, label, icon, onClick }: { title: string; label: string; icon: ReactNode; onClick: () => void }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2} color="#ffffff" styles={{ root: { color: "#242529", boxShadow: "0 8px 24px rgba(15,23,42,.16)", fontSize: 13, fontWeight: 500 } }}>
            <button type="button" className="group relative flex h-12 items-center whitespace-nowrap px-1.5" onClick={onClick} aria-label={title}>
                <span className="flex h-9 items-center gap-2 rounded-lg px-2.5 transition group-hover:bg-[#f0f0f1]">
                    {icon}
                    <span>{label}</span>
                </span>
            </button>
        </Tooltip>
    );
}
