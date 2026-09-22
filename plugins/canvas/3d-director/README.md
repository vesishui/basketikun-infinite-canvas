# 3D 导演台 3d-director

把 [jlmlh-3d-director](https://github.com/lkhxxx123/jlmlh-3d-director)(MIT)嵌成画布节点:摆人物与机位、打关键帧运镜、按机位截图回画布。连入图片节点后,这张图作为全景背景送进导演台。

**双击卡片打开**全屏面板;卡片本身不渲染导演台(那套应用一加载就是 2MB JS + 一个 WebGL 场景,画布里多放几个会直接拖垮页面)。

## 打通的两条链路

- **上游图片 → 全景背景**:取第一个有内容的上游图片节点,通过 postMessage 送进导演台当全景;在导演台里移除背景会同步删掉这条连线。
- **导演台截图 → 画布图片节点**:导演台发回的截图在**本节点右侧**按原始比例依次落成图片节点(不自动选中,免得抢走当前选择)。

模型与参数不在这里定:导演台只负责摆位/运镜/截图,后续拿截图节点继续走画布内置生图链路时,模型仍由用户自选。

## 静态产物必须本地托管

导演台本体是第三方应用,静态产物放 `web/public/director-desk/`(`index.html` + `assets/*` + `models/*`,约 2.1MB),**不入库**(见根 `.gitignore`)。

产物必须与画布**同源**:iframe 里那套宿主桥按 origin 校验,跨域会直接不工作。插件里路径写成带 origin 的完整 URL(`new URL("/director-desk/…", location.href)`),因为宿主是用 Blob + `import(blobUrl)` 执行插件的,blob URL 没有目录基址,裸相对路径会报 `Failed to resolve module specifier`。

**必须放真实文件,不能软链**:Vite 扫描 public 目录时只要发现符号链接就整体放弃(`ERR_SYMLINK_IN_RECURSIVE_READDIR`),`/director-desk/*` 会被 SPA fallback 成 `index.html`,导演台只会白屏。

首次准备或换机器时跑:

```bash
bash plugins/canvas/3d-director/scripts/fetch-director-desk.sh        # 已有产物则跳过
bash plugins/canvas/3d-director/scripts/fetch-director-desk.sh --force # 强制重建
```

脚本会下载源码 → `npm install` → `npx vite build` → 复制进 `web/public/director-desk/` 并自检。源码缓存在 `/Volumes/Acer2/Model/director-desk-src`(可用 `MODEL_ROOT` 改,未挂载则退回临时目录)。直连 GitHub 不通时用镜像:

```bash
DIRECTOR_DESK_PROXY=https://gh-proxy.com/ bash plugins/canvas/3d-director/scripts/fetch-director-desk.sh
```

这里用 `npx vite build` 而不是 `npm run build`:上游的 `tsc -b` 会因缺失测试文件/`vite-env.d.ts` 报错,而产物本身不需要类型检查通过。构建时会警告三处「模型库」缩略图找不到——那是作者本机的外部素材路径,见下方已知限制。

## 构建 / 安装

```bash
cd plugins/canvas/3d-director
npm install
npm run build      # → dist/3d-director.js,并同步到 web/public/plugins/3d-director.js
npm run typecheck
```

产物会自动进「节点插件」管理器列表(默认关闭),打开开关即启用。官方插件注册表(`plugins/canvas/registry/build.mjs`)里已登记本插件。

## 已知限制

- 导演台源码里的「模型库」引用了作者本机的外部素材目录(鹿头骨/台钻/保温瓶),这些条目在插件环境会加载失败;不影响摆位/运镜/关键帧/截图。
- 只取第一个上游图片节点作为全景背景。
- 截图回传的是 PNG,不写回原节点,便于保留原始分镜。
