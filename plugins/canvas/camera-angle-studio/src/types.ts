// 镜头视角标注台插件 —— 类型定义

/** 节点三态(存 metadata.stage,刷新恢复) */
export type StudioStage = "empty" | "ready" | "generated";

/** 箭头参数(全部为实时计算的原始值) */
export type Arrow = {
    x0: number; // 机位(尾圆)相对画布区像素
    y0: number;
    x1: number; // 方向(箭头尖)相对画布区像素
    y1: number;
    strokeWidth: number; // 杆粗(2-16),→ 光圈
    depthOut: boolean; // 右键拖拽 → 纵深轴"朝画面前方退出"
};

/** 生成设置 */
export type StudioSettings = {
    resolution: string; // 2K / 4K
    quality: string; // 高质量 / 超高质量
    ratio: string; // 16:9 / 9:16 / 1:1 / 自定义
    customRatio: string; // 自定义时输入的数字(如 2.35 → 2.35:1)
};

/** 节点 metadata 数据结构 */
export type StudioMeta = {
    stage: StudioStage;
    image?: string; // 场景图(dataURL)
    settings: StudioSettings;
    generated: boolean; // 是否已 mock 生成过新视角
};

export const DEFAULT_SETTINGS: StudioSettings = {
    resolution: "2K",
    quality: "高质量",
    ratio: "16:9",
    customRatio: "2.35",
};

export const EMPTY_META: StudioMeta = {
    stage: "empty",
    settings: DEFAULT_SETTINGS,
    generated: false,
};
