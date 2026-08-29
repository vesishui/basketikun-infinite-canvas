// 脚本生成器插件 —— 类型定义

/** 节点四种外观状态(状态机存于 metadata.stage) */
export type Stage = "initial" | "input" | "progress" | "full";

/** 全屏编辑器三步 */
export type StepKey = "shots" | "assets" | "prompts";

/** 一个分镜镜头(Step1 表格的一行) */
export type Shot = {
    id: string;
    number: number; // 镜号
    duration: number; // 时长(秒),默认 5
    description: string; // 画面描述(含实体词,渲染为青色高亮)
    entities: string[]; // 实体词(角色名/场景名/道具名),用于高亮
    shotSize: string; // 景别
    lighting: string; // 光影氛围
    dialogue: string; // 对白旁白
    sound: string; // 音效
    cameraMove: string; // 运镜
    finalPrompt: string; // 最终提示词
    rowColor: string; // 行标注色("" 为默认无背景)
};

/** 资产(角色/场景/道具) */
export type AssetKind = "character" | "scene" | "prop";

export type Asset = {
    id: string;
    kind: AssetKind;
    name: string;
    description: string;
    image?: string; // 未设置图则 undefined(mock 占位)
};

export type AssetGroup = {
    characters: Asset[];
    scenes: Asset[];
    props: Asset[];
};

/** Step3 每镜的提示词 */
export type ShotPrompt = {
    shotId: string;
    prompt: string; // 分镜提示词
    motionPrompt: string; // 视频运动提示词
};

/** 节点 metadata 数据结构 */
export type ScriptMeta = {
    stage: Stage;
    steps: Record<StepKey, boolean>;
    shots: Shot[];
    assets: AssetGroup;
    stylePrompt: string; // Step2 顶部全局风格描述
    prompts: ShotPrompt[]; // Step3 逐镜提示词
    inputPrompt: string; // input 态输入框内容
    referenceImage?: string; // input 态参考图(dataURL)
    model: string; // input 态模型
};

export const EMPTY_META: ScriptMeta = {
    stage: "initial",
    steps: { shots: false, assets: false, prompts: false },
    shots: [],
    assets: { characters: [], scenes: [], props: [] },
    stylePrompt: "",
    prompts: [],
    inputPrompt: "",
    model: "",
};
