# 分镜台(storyboard-board)节点插件

给 Infinite Canvas 扩展一个「分镜台」节点:一整块视频分镜板,按时间顺序排列所有镜头(分镜格),
可用于视频前期策划、分镜脚本整理与分镜画面预演。

## 功能

- **单节点整块分镜板**:一个节点 = 一块板子,内部按网格排列所有镜头,镜头数/总时长显示在板头。
- **每格字段(常用全套)**:镜号、景别(远景/全景/中景/近景/特写)、运镜(固定/推/拉/摇/移/跟/升降)、
  画面描述、台词/旁白、时长(秒)。
- **AI 生成每格画面**:每格可「🎨 生成画面」,用 `ctx.ai.generateImage` 按该格画面描述生成 16:9 电影感分镜图,
  结果存进该格 metadata 并直接展示;已生成可「🔄 重生成」。
- **一句话 AI 铺全板**:面板里输入故事/脚本 + 镜头数,AI 用 `generateText` 自动拆成分镜镜头铺满整块板。
- **镜头管理**:面板内添加/编辑/保存镜头,卡片上可直接上移/下移/删除,镜号自动重排。
- **输出为上游资源**:分镜台作为上游被下游节点消费时,输出整块分镜板文本(镜号/景别/运镜/描述/台词/时长)。

## 数据模型

所有镜头存在节点 `metadata.shots`(数组,整体替换,浅合并持久化 + 可撤销):

```ts
type Shot = {
    id: string;
    number: number;      // 镜号
    shotSize: string;    // 景别
    cameraMove: string;  // 运镜
    description: string; // 画面描述
    dialogue: string;    // 台词/旁白
    duration: number;    // 时长(秒)
    image?: string;      // 分镜画面图(dataURL)
};
```

面板正在编辑的镜头 id 存于 `metadata.editingShotId`(空串表示新建)。

## 构建 / 安装

```bash
cd plugins/canvas/storyboard-board
npm install
npm run build    # → dist/storyboard-board.js,并同步到 web/public/plugins/storyboard-board.js
```

- **本地开发**:画布启动时自动发现 `web/public/plugins/` 下的插件;或把 `storyboard-board.js` 的 URL
  填进画布「节点插件」管理器安装。
- **发布**:把 `dist/storyboard-board.js` 托管到任意静态地址即可供用户安装;加入官方插件请在
  `plugins/canvas/registry/build.mjs` 的 `OFFICIAL` 中登记。

## 注意事项

- 交互控件均做了 `onMouseDown` stopPropagation 与 `data-canvas-no-zoom`,避免误触节点拖动/画布缩放。
- 生成画面 / AI 铺板依赖宿主 AI 配置;未配置时宿主会弹配置窗,插件内 try/catch 提示。
- 画面描述为空时点「生成画面」会提示先填写描述。
