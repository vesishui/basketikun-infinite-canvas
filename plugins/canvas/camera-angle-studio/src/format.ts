// 镜头视角标注台插件 —— 箭头参数计算 + 提示词模板生成(纯函数)
// 拖动箭头时所有派生值都从这几个函数实时算出,保证 UI 同步无滞后。

import type { Arrow } from "./types";

// ---------------------------------------------------------------------------
// 基础几何
// ---------------------------------------------------------------------------

export type ArrowDerived = {
    len: number;
    dx: number;
    dy: number;
    focal: number; // 18-200mm
    aperture: number; // f/1.4 - f/16 档位
    pitchDeg: number; // ±45°,正 = 俯拍(箭头尖在机位下方)
    side: "左" | "右" | "中央"; // 机位位于画面左/右/中央侧
    heading: "左" | "右" | "正前"; // 朝画面左/右/正前方
    lateral: "左" | "右"; // 左右轴:箭头水平方向(dx 符号)
    depth: "前方退出" | "深处推进";
};

export function deriveArrow(arrow: Arrow, areaWidth: number, areaHeight: number): ArrowDerived {
    const dx = arrow.x1 - arrow.x0;
    const dy = arrow.y1 - arrow.y0;
    const len = Math.max(1, Math.hypot(dx, dy));

    // 长度 → 焦段 18-200mm(参考长度取画布短边 60%)
    const refLen = Math.max(120, Math.min(areaWidth, areaHeight) * 0.6);
    const focal = Math.round(18 + Math.min(1, len / refLen) * (200 - 18));

    // 杆粗 2-16 → 光圈档位(粗 = 大光圈 = f 值小)
    const aperture = apertureFromStroke(arrow.strokeWidth);

    // 垂直分量 → 俯仰 ±45°(dy 向下为正 → 俯拍为正)
    const pitchDeg = Math.round(Math.min(45, (Math.abs(dy) / len) * 45) * (dy >= 0 ? 1 : -1));

    // 机位位于画面左/右/中央侧
    const side: ArrowDerived["side"] = arrow.x0 < areaWidth / 3 ? "左" : arrow.x0 > (areaWidth * 2) / 3 ? "右" : "中央";

    // 朝画面左/右/正前方(|dx| 很小视为正前)
    const heading: ArrowDerived["heading"] = Math.abs(dx) / len < 0.18 ? "正前" : dx >= 0 ? "右" : "左";

    // 左右轴:箭头水平方向(dx 符号)
    const lateral: ArrowDerived["lateral"] = dx >= 0 ? "右" : "左";

    // 纵深轴:右键拖拽 = 朝画面前方退出,左键拖拽 = 深处推进
    const depth: ArrowDerived["depth"] = arrow.depthOut ? "前方退出" : "深处推进";

    return { len, dx, dy, focal, aperture, pitchDeg, side, heading, lateral, depth };
}

// ---------------------------------------------------------------------------
// 光圈:杆粗 2-16 → 档位(粗 → 大光圈)
// ---------------------------------------------------------------------------

export const APERTURES = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];

export function apertureFromStroke(strokeWidth: number): number {
    const t = Math.min(1, Math.max(0, (strokeWidth - 2) / (16 - 2)));
    const idx = Math.round(t * (APERTURES.length - 1));
    return APERTURES[Math.min(APERTURES.length - 1, Math.max(0, idx))];
}

/** 滚轮微调:dir=+1 光圈变小(f 值增大),dir=-1 光圈变大 */
export function apertureStep(current: number, dir: 1 | -1): number {
    const idx = APERTURES.indexOf(current);
    if (idx < 0) return current;
    const next = idx - dir; // 滚轮向下(正 delta) → f 值增大 → 光圈变小
    if (next < 0 || next >= APERTURES.length) return current;
    return APERTURES[next];
}

export function formatAperture(a: number): string {
    return a % 1 === 0 ? String(a) : a.toFixed(1);
}

// ---------------------------------------------------------------------------
// 注释映射
// ---------------------------------------------------------------------------

export function focalNote(focal: number): string {
    if (focal <= 24) return "超广角焦段,视野极其开阔,边缘略畸变";
    if (focal <= 35) return "广角焦段,视野开阔";
    if (focal <= 70) return "标准焦段,透视自然";
    if (focal <= 135) return "中长焦焦段,轻微压缩感";
    return "长焦焦段,背景强烈压缩,空间扁平";
}

export function apertureNote(aperture: number): string {
    if (aperture <= 2.0) return "大光圈,景深极浅,主体突出背景虚化强烈";
    if (aperture <= 4.0) return "中等光圈,主体清晰、背景微虚";
    if (aperture <= 8.0) return "小光圈,前后清晰,整体实焦";
    return "极小光圈,全景深,星光效果";
}

// ---------------------------------------------------------------------------
// 提示词模板(严格按需求结构拼接)
// ---------------------------------------------------------------------------

export type PromptArgs = {
    side: ArrowDerived["side"];
    heading: ArrowDerived["heading"];
    lateral: ArrowDerived["lateral"]; // 左右轴独立于 heading
    pitchDir: "仰" | "俯";
    pitchDeg: number;
    depth: ArrowDerived["depth"];
    focal: number;
    aperture: number;
};

export function buildAutoPrompt(args: PromptArgs): string {
    const { side, heading, lateral, pitchDir, pitchDeg, depth, focal, aperture } = args;
    return (
        "重绘这个场景的新视角画面:机位严格设在图中红色箭头的尾部," +
        "镜头严格朝向箭头前端所指的方向拍摄。机位位于画面" + side + "侧," +
        "朝画面" + heading + "方拍摄,新机位与朝向必须与箭头两端严格一致。" +
        "镜头朝向三轴:左右轴——朝画面" + lateral + "侧;上下轴——" +
        pitchDir + "拍约" + pitchDeg + "°;纵深轴——朝画面" + depth + "。" +
        "重绘画面必须体现这三个轴向上的视角变化。使用" + focal + "mm焦段镜头(" +
        focalNote(focal) + "),光圈 f/" + formatAperture(aperture) + "(" +
        apertureNote(aperture) + "),保持场景主体、光线与氛围不变," +
        "按新机位与朝向重绘画面,场景元素不动。"
    );
}

/** 由箭头直接生成完整自动提示词(供文本域联动) */
export function autoPromptFromArrow(arrow: Arrow, areaWidth: number, areaHeight: number): string {
    const d = deriveArrow(arrow, areaWidth, areaHeight);
    return buildAutoPrompt({
        side: d.side,
        heading: d.heading,
        lateral: d.lateral,
        pitchDir: d.pitchDeg >= 0 ? "俯" : "仰",
        pitchDeg: Math.abs(d.pitchDeg),
        depth: d.depth,
        focal: d.focal,
        aperture: d.aperture,
    });
}
