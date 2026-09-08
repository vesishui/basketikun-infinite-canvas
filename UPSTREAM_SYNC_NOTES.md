# 上游同步笔记(v0.17.0 / v0.18.0 → 本地)

> 上游 `basketikun/infinite-canvas` 于 2026-09-02 发布 v0.17.0、2026-09-07 发布 v0.18.0。
> 本地基线约为 2026-08-27 的 main 快照(已含 v0.17 大部分功能的本地化实现)。
> 本文记录:本次已同步的部分、延后待研究的大改动、以及上游 CORS 方案的研究结论。
> **2026-09-08 更新:v0.18.0 全量合并已完成(见「二」各节标记),原延后项全部落地。**

## 一、本次已同步(提交 e506c36)

| 内容 | 说明 |
|---|---|
| 「本地代理」配置页签 | 配置弹窗新增页签:开关 + 代理地址 + 启动命令展示 + 测试连接(仿上游 config-local-proxy) |
| `withLocalProxy` / `isLocalProxyEnabled` | 加在 `use-config-store.ts`;代理开启时把外发 URL 包上 `http://127.0.0.1:23210/` 前缀 |
| 调用脚本直传 | `model-plugin.ts` 的 http/request 在代理开启时改为浏览器直传(浏览器 → canvas-proxy → 目标),JSON/FormData/blob 都支持;关闭时仍走 canvas-agent 中继 |
| 图床上传直传 | `image-host.ts` 在代理开启时用浏览器 FormData 直传(不再把图片 base64 发给 agent),litterbox→uguu→imgBB 链与缓存逻辑不变 |
| relay 直连回退也走代理 | `relay.ts` 无 agent 时的浏览器直连回退包上 withLocalProxy |
| vendor canvas-proxy | 上游的纯转发代理工具(约 130 行,零依赖)已拷到 `canvas-proxy/`,可 `node canvas-proxy/index.js` 直接跑,不必 npx 拉网 |

**使用方式**:配置 → 本地代理 → 开开关 → 终端运行 `node canvas-proxy/index.js`(或 `npx @basketikun/canvas-proxy@latest`)→ 测试连接。渠道、图床地址仍填真实地址。

**上游 CORS 方案研究结论(回答“前端直传是否可行”)**:可行。上游 v0.18 的思路是本地起一个补 CORS 头的纯转发代理,前端所有请求(`withLocalProxy`)先发本机再转发,浏览器侧无跨域限制、无 payload 大小问题(不经 agent JSON 封装)。已按此接入你现有的图床链与调用脚本,且默认关闭、关闭时行为与之前完全一致。

## 二、上游大改动(原延后,2026-09-08 已全部合并落地)

按影响从大到小。每一项都是“上游重写了本地也大改过的同一批文件”,直接合并必然冲突,需要逐个人工决策。

### 1. 视频设置重构 + 首尾帧/全能参考模式(影响 ★★★★★)
**✅ 已合并**:`lib/media-size.ts` 新增,`video-settings-panel.tsx`/`canvas-video-settings-popover.tsx`/`video.ts` 换上游版;时长 4–30 秒滑杆;秒数 pill 与数字输入移除;`normalizeVideoSeconds` = 上游 `clampVideoSeconds`。
- 上游:`video-settings-panel.tsx`、`canvas-video-settings-popover.tsx`、`video.ts`、`lib/media-size.ts`(新)、`types/canvas.ts`
- 内容:1k/2k/4k 与宽高比拆开计算尺寸;视频用 480p/720p/1080p + 6 种比例计算宽高;时长改 4–30 滑杆;新增首尾帧(frames)/全能参考(reference)模式,`params.mode` 传给脚本,参考图按模式分字段发送。
- 冲突点:本地已改过 30s 钳制和 6/10/12/16/20/30 秒选项;上游把这块整个换成了 `media-size.ts` 里的 `clampVideoSeconds`(4–30)。
- 建议:合。你的 30s 需求上游已覆盖(上限同为 30),合并后删掉本地两处 `normalizeVideoSeconds` 的手工钳制,但保留“6 秒默认”和秒数 pill 可按你习惯调。

### 2. 画布视频节点保存远端任务 ID + 刷新续查(影响 ★★★★★)
**✅ 已合并**:`project.tsx` 用上游 `completeVideoNodeTask`/`pollVideoNodeTask` 任务续查架构,刷新后 `hasResumableVideoTask` 自动恢复轮询;节点 metadata 持久化 `videoTaskId`/`videoTaskProvider`;工具条与信息弹窗展示任务 ID。本地进度回调保留(`waitForVideoGenerationTask` 透传 `onProgress`)。
- 上游:`canvas-node-generation.ts`、`video.ts`、canvas store
- 内容:任务 ID 持久化到节点,刷新页面后自动继续查询状态直到成功/失败,也可手动刷新任务状态。
- 冲突点:本地对 `canvas-node-generation.ts` 和 video 轮询链路有自己的改动(d14e472 等)。
- 建议:合。这是稳定性大提升(长视频任务不怕刷新),但需要仔细过一遍本地轮询差异。

### 3. 调用脚本默认模板 + 多参考视频/音频 + 全屏分步编辑器(影响 ★★★★)
**✅ 已合并**:`model-plugin.ts` 上游模板与 `videos`/`audios` File[] 传参,本地 relay/直传请求层保留;`model-script-editor.tsx` 换上游全屏分步版;`uploadImage` 变量注入保留;`audio.ts` 参考音频转 File[] 传入脚本。
- 上游:`model-script-editor.tsx`、`model-plugin.ts`
- 内容:默认模板改英文 JSDoc 写法,补齐图片质量/背景/参考素材字段;脚本可使用参考视频、参考音频;编辑器改全屏分步,支持复制写脚本说明给外部 AI。
- 冲突点:本地的 `model-plugin.ts` 已大改(relay 直传、uploadImage、audios);模板内容两边不同。
- 建议:部分合——参考上游模板里的字段写法更新你的 aicost/xinfeng 脚本;编辑器 UI 可以合,但注意保留本地 uploadImage 变量注入。

### 4. 多选打组/组节点树形列表/参考栏组展开(影响 ★★★★)
**✅ 已合并**:`canvas-selection-toolbar.tsx` 上游新版,`use-canvas-store.ts`/`canvas-context-menu.tsx`/`canvas-side-panel.tsx`/`canvas-top-bar.tsx`(打组快捷键)取上游;本地参考栏/组引用展开实现与上游组模型已共存,project.tsx 中两边 `groupSelection` 等函数一致。
- 上游:`canvas-selection-toolbar.tsx`(新)、`use-canvas-store.ts`、`canvas-context-menu.tsx`、`canvas-side-panel.tsx`
- 内容:多选整体虚线选区、一键打组/解组;左侧列表树形展示组层级;组作为生成输入。
- 冲突点:本地 `use-canvas-store.ts` 有自己的组实现(canvas-node-reference-bar、组引用展开等),两边组语义不同,不是同构合并。
- 建议:先梳理两边组模型的差异再决定,不要直接覆盖。

### 5. 遮罩编辑重构(影响 ★★★)
**✅ 已合并**:`canvas-node-mask-edit-dialog.tsx` 换上游版(补图重生成 + generate 标志),`project.tsx` 的 `maskEditImageNode` 换上游实现(画布生成遮罩标注图节点,作为第二张参考图提交);`image.ts` requestEdit 在 script 分支把 mask 并入参考图,`mask` 参数保留以兼容旧调用。i18n 新增 `maskNodeTitle` 并更新 `maskPrompt` 文案。
- 上游:`canvas-node-mask-edit-dialog.tsx`、`image.ts`
- 内容:不再用接口 mask 参数,改为画布生成遮罩标注图提交;支持直接补图重生成。
- 冲突点:本地该文件与基线一致(无定制),可考虑原样跟进,但会改 image.ts 生图链路。

### 6. 其他小项(影响 ★★,后续顺手即可)
**✅ 已合并**:WebDAV/媒体文件经代理转发(`webdav-sync.ts`/`file-storage.ts`/`app-sync.ts`)、`image-storage.ts` 上游健壮版 + relay 回退、资产下载读本地内容、`canvas-resource-references.ts` 文本分块编号、URL 凭据按 Base URL 匹配渠道(`app-config-modal.tsx`/渠道凭据导入)、docs 站上游更新;canvas-agent 上游测试(126 个全过)。
- WebDAV 经本地代理转发、同步不再恢复已删画布(`app-sync.ts`、`webdav-sync.ts`、`file-storage.ts`)
- Gemini imageConfig 修复(`image.ts`):本地 image.ts 大改过,需摘取该提交单独合
- 我的资产下载读本地文件内容修复(`pages/assets/index.tsx`)
- 生成提示词「文本N」分块编号(`canvas-resource-references.ts`)
- 多参考图编辑按 OpenAI 规范 `image[]` 提交(`image.ts` 内置脚本)
- URL 导入凭据按 Base URL 匹配渠道(`app-config-modal.tsx`)
- 文档站移动端目录/英文路径重定向修复(docs 站,与画布无关)

## 三、合并操作备忘

- 上游 tarball:`https://codeload.github.com/basketikun/infinite-canvas/tar.gz/refs/heads/main`(git clone 走代理会 502,codeload 稳定)
- 基线对照:`/tmp/ic-v016`(上游 v0.16.0)与 `/tmp/ic-upstream`(v0.18.0 main)可用来做三方对比
- 本仓库 `git commit` 受 index.lock 困扰(IDE 后台进程),提交用 plumb 工作流:`GIT_INDEX_FILE=/tmp/xx git read-tree HEAD && git add ... && git write-tree && git commit-tree`,再写 `.git/refs/heads/<branch>`
- `.git/objects` 里有若干 `tmp_obj_*` 残留无法删除(权限),IDE 重启后 `git prune` 清理
