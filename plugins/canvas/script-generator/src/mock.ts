// 脚本生成器插件 —— mock 数据(本期不发任何网络请求)

import type { Asset, AssetGroup, ScriptMeta, Shot, ShotPrompt } from "./types";

// ---------------------------------------------------------------------------
// 实体词青色高亮的标记约定:
// 画面描述里用 [[名字]] 包裹实体词,mock 数据里手动标注;
// 渲染时把 [[...]] 替换成青色高亮标签,同时收集进 shot.entities。
// ---------------------------------------------------------------------------

let seq = 0;
export function nextId(prefix = "id"): string {
    seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

// 从描述文本解析 [[实体]] 标记 → 去标记文本 + 实体词列表
export function parseEntities(description: string): { text: string; entities: string[] } {
    const entities: string[] = [];
    const text = description.replace(/\[\[([^\]]+)\]\]/g, (_, name: string) => {
        if (!entities.includes(name.trim())) entities.push(name.trim());
        return name.trim();
    });
    return { text, entities };
}

// ---------------------------------------------------------------------------
// 初始 mock:一个"自己编写"或"生成"出来的示例分镜脚本(带实体词标注)
// ---------------------------------------------------------------------------

export function makeMockShots(): Shot[] {
    const rows: Array<[string, string, string, string, string, string, string]> = [
        // [画面描述, 景别, 光影, 对白, 音效, 运镜, 最终提示词]
        ["雨夜,[[林澈]]撑着伞走进霓虹闪烁的[[旧城区]],街角[[老式电话亭]]亮着暖光", "全景", "霓虹蓝紫,雨幕反射", "林澈(旁白):这座城市一到下雨,记忆就开始回流。", "雨声、远处的车流声", "缓推", "赛博朋克雨夜,林澈撑伞入画,霓虹旧城区,暖光电话亭"],
        ["[[林澈]]在[[老式电话亭]]里拨号,屏幕闪烁,露出焦急而期待的神情", "近景", "冷暖对比,电话亭暖光", "林澈:妈,是我…", "电话拨号音、忙音", "固定", "近景,电话亭内林澈拨号,神情焦急"],
        ["画面切入十年前,童年的[[林澈]]与母亲在[[旧城区]]街角奔跑", "中景", "暖黄阳光,怀旧", "童年林澈:等等我呀!", "夏日蝉鸣、笑声", "跟拍", "怀旧暖黄,童年林澈与母亲街角奔跑"],
        ["回到现在,[[林澈]]挂断电话,泪水滑落,转身走向霓虹深处", "特写", "逆光,轮廓光", "林澈(低语):谢谢你,让我再见她一面。", "雨声渐弱、钢琴", "慢拉", "特写,林澈泪落,转身走向霓虹深处"],
    ];
    return rows.map((r, i) => ({
        id: nextId("shot"),
        number: i + 1,
        duration: 5,
        description: r[0],
        entities: parseEntities(r[0]).entities,
        shotSize: r[1],
        lighting: r[2],
        dialogue: r[3],
        sound: r[4],
        cameraMove: r[5],
        finalPrompt: r[6],
        rowColor: "",
    }));
}

export function makeMockAssets(): AssetGroup {
    const c = (name: string, description: string): Asset => ({ id: nextId("asset"), kind: "character", name, description });
    const s = (name: string, description: string): Asset => ({ id: nextId("asset"), kind: "scene", name, description });
    const p = (name: string, description: string): Asset => ({ id: nextId("asset"), kind: "prop", name, description });
    return {
        characters: [
            c("林澈", "25岁青年,深色风衣,眼神里藏着心事"),
            c("母亲", "中年女性,温柔,穿着旧式碎花裙"),
        ],
        scenes: [
            s("旧城区", "雨夜霓虹的潮湿街道,招牌错落"),
            s("电话亭", "老式红色电话亭,暖黄灯光"),
        ],
        props: [
            p("老式电话亭", "复古拨盘电话,暖光"),
            p("旧照片", "泛黄的家庭合影,边缘卷曲"),
        ],
    };
}

export const MOCK_STYLE_PROMPT =
    "赛博朋克与怀旧融合:霓虹色彩、潮湿反光、冷暖光对比,电影级布光,高细节,16:9 构图。";

// Step3 逐镜提示词 mock(与 makeMockShots 对应)
export function makeMockPrompts(shots: Shot[]): ShotPrompt[] {
    return shots.map((shot) => ({
        shotId: shot.id,
        prompt: shot.finalPrompt,
        motionPrompt: "镜头" + shot.cameraMove + ",画面平稳,雨丝持续下落,霓虹光在雨幕中晕开",
    }));
}

export function makeInitialMeta(): ScriptMeta {
    const shots = makeMockShots();
    return {
        stage: "initial",
        steps: { shots: false, assets: false, prompts: false },
        shots,
        assets: makeMockAssets(),
        stylePrompt: MOCK_STYLE_PROMPT,
        prompts: makeMockPrompts(shots),
        inputPrompt: "",
        model: "grok-imagine",
    };
}

// ---------------------------------------------------------------------------
// 下拉选项(mock)
// ---------------------------------------------------------------------------

export const IMAGE_MODELS = ["grok-imagine", "seedream-3.0", "flux-pro", "midjourney"];

export const VIDEO_MODELS = ["seedance-1.0", "kling-v2", "runway-gen3", "sora-2"];

export const QUALITY_OPTIONS = ["标准", "高清", "超清"];

export const RESOLUTION_OPTIONS = ["720P", "1080P", "2K", "4K"];

export const RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3"];

// 行标注色:第一个为默认(无背景),后面为标注用色
export const ROW_COLORS = ["", "#22d3ee", "#f59e0b", "#34d399", "#f472b6", "#a78bfa"];

export const SHOT_SIZE_OPTIONS = ["远景", "全景", "中景", "近景", "特写"];

export const CAMERA_MOVE_OPTIONS = ["固定", "推", "拉", "摇", "移", "跟", "升降"];

// 强调青色(实体词高亮 / 风格描述),统一管理便于微调
export const ACCENT = "#06b6d4";
export const ACCENT_DIM = "#0e7490";
export const ACCENT_BG = "rgba(6,182,212,.14)";
