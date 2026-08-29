# 脚本生成器(script-generator)节点插件

给 Infinite Canvas 扩展一个「脚本生成器」节点:从剧本/故事生成分镜脚本,
走三步流程(确认镜头 → 准备资产 → 合成提示词),支持批量生图与批量生视频。

**本期仅做 UI,所有数据为本地 mock,不发任何网络请求。**

## 节点四种外观状态(状态机存于 `metadata.stage`)

| 状态 | 外观 |
|---|---|
| `initial` | 卡片三个竖排入口:「剧本生成分镜脚本」「角色生成分镜脚本」「自己编写分镜脚本」。前两项 → input 态;第三项 → 直接打开全屏编辑器 |
| `input` | 上方大框显示连接的上游文本预览(未连接为空);下方「参考图」上传按钮 + 大 textarea + 模型下拉 + 发送按钮 |
| `progress` | 三步 stepper(确认镜头/准备资产/合成提示词),已完成步骤打勾;下方「打开脚本节点 →」 |
| `full` | 同 progress;节点上方常驻工具条:重新生成 / 批量生成分镜 / 批量生视频 / 导出;步骤未完成时批量按钮置灰,hover 显示 tooltip「需先完成三步步骤」 |

关闭全屏编辑器后,节点外观按已完成步骤自动切换(完成 step1 → progress 态且第 1 格打勾;三步全完成 → full 态)。

## 全屏脚本编辑器(三步)

- **顶部**:居中三步 stepper,当前步骤高亮,完成打勾;右上角 ✕ 关闭。
- **Step1 确认镜头**:全屏表格,列 = 镜号 / 时长(默认 5s) / 画面描述 / 景别 / 光影氛围 / 对白旁白 / 音效 / 运镜 / 最终提示词 / 操作。
  - 单元格点击变输入框编辑,失焦/回车保存;
  - 画面描述中的实体词(`[[名字]]`,mock 手动标注)渲染为**青色高亮标签**;
  - **双击画面描述**弹出编辑浮层(浮在当前行下方),输入 `@` 可选择资产引用,底部提示「输入@选择资产,失焦自动保存」+ 右侧保存按钮;
  - 操作列「…」弹出:上一行 6 个圆点颜色(第一个为默认,其余为标注色,可改变当前行背景/边框),下一行「删除该行」;
  - 底部「+ 添加镜头」,右下「下一步:准备资产 →」。
- **Step2 准备资产**:顶部全局风格描述(青色高亮);下方角色/场景/道具三组网格卡片(图占位「生成或上传角色图/场景图/道具图」+ 名称 + 描述截断 + 右上「…」),网格末尾「+ 新增」虚线卡片;有资产未设图时底部左侧提示条 + 右侧「✨ 一键生成所有资产」(mock);右下「下一步:合成提示词 →」。
- **Step3 合成提示词**:回到表格,「最终提示词」列名暗青色亮;每行「待生成提示词」按钮 → 中间弹窗(标题「第 n 镜:最终提示词」,上方分镜提示词 + 下方视频运动提示词,可关闭);右下「✨ 一键生成全部提示词」(mock)。

## 批量弹窗(工具条触发,需三步全部完成才点亮)

- **分镜批量生图**:标题「分镜批量生图」,顶部说明条「会优先使用已生成的角色、场景和道具参考图」,中部镜头复选列表,底部:已选计数 + 模型/画质/分辨率/宽高比下拉 + 「确认并创建生成器组(N)」。点击仅弹 toast。
- **批量生视频**:镜头复选列表每行带秒数设置(点击 −/+ 或手填,4s–30s,默认 5s),底部同生图。点击仅弹 toast。

## 宿主扩展(fullscreenPanel)

为支撑插件全屏 Modal,宿主新增了节点定义字段 **`fullscreenPanel?: boolean`**:
声明后,该节点的自定义 `Panel` 由宿主渲染在**视口级 fixed 容器**中(而非默认的节点下方面板),
使插件内的 `position: fixed` 全屏 UI 不受画布缩放变换(`transform: scale()`)影响。

涉及文件(宿主真源 + SDK 镜像):
- `web/src/types/canvas-plugin.ts`
- `plugins/canvas/sdk/src/types.ts`
- `web/src/components/canvas/canvas-node.tsx`(Panel 渲染分支)

## 数据模型

节点 `metadata` 扁平字段:
```ts
{
  stage: "initial" | "input" | "progress" | "full";
  steps: { shots: boolean; assets: boolean; prompts: boolean };
  shots: Shot[];            // 分镜表格数据
  assets: AssetGroup;       // characters / scenes / props
  stylePrompt: string;      // 全局风格描述
  prompts: ShotPrompt[];    // 每镜最终提示词
  inputPrompt: string;      // input 态输入
  referenceImage?: string;  // input 态参考图(dataURL)
  model: string;
  panelMode?: "editor" | "batch-image" | "batch-video"; // 全屏面板模式
}
```

## 构建 / 安装

```bash
cd plugins/canvas/script-generator
npm install
npm run build    # → dist/script-generator.js,并同步到 web/public/plugins/script-generator.js
```

画布启动时自动发现 `web/public/plugins/` 下的插件;刷新画布页面后,在创建菜单找到「📜 脚本生成器」即可使用。

## 注意

- 本期全部 mock:不发起任何网络请求;「生成」「批量」「导出」「一键生成」均只改变本地 UI 状态或弹 toast。
- 参考图上传使用浏览器本地 FileReader(读为 dataURL),不上传。
- 全屏编辑器/批量弹窗由宿主 `fullscreenPanel` 机制渲染在视口级,关闭后节点外观按已完成步骤切换。
