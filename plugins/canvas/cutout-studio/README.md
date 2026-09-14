# 抠图工作台 cutout-studio

把海报拆成可独立编辑/做动画的图层。连入图片节点 → 双击打开工作台。

## 两种分层方式

- **加图层（点选）**：在图上点一下，SAM 点选分割出该对象，角标编号即图层号；拖动角标重新分割，`×` 删除。
- **一键分层**：网格采样点自动分割，按面积过滤 + IoU 去重，最多 12 层，结果追加为角标。

模型 `Xenova/slimsam-77-uniform`（transformers.js，量化权重约 13MB），跑在 WASM 上；全图特征只算一次，之后每次点选约 180ms。

不要切到 WebGPU：实测同一份量化权重在 WebGPU 上分割结果完全错位（点蓝圆却给到画面别处，命中率约 12%），且比 WASM 更慢。

权重**本地托管**在 `web/public/models/Xenova/slimsam-77-uniform`（`onnx/*_quantized.onnx` + 三个 json），插件只从本站 `/models/` 读，不请求外网。浏览器直连 hf-mirror.com 会直接 `Failed to fetch`，所以不要改回远程加载。

前端运行时同样本地化：`transformers.min.js`（888KB）+ `ort-wasm-simd-threaded.jsep.wasm`（21MB）放在 `web/public/vendor/`，由 `bash scripts/fetch-runtime.sh` 从 npm 复制进来。此前插件直连 `cdn.jsdelivr.net` 拉 ESM，代理一关就整个插件不可用。插件里这些路径都写成带 origin 的完整 URL（`new URL("/vendor/…", location.href).href`）：宿主是用 Blob + `import(blobUrl)` 执行插件的，blob URL 没有目录基址，裸相对路径会直接报 `Failed to resolve module specifier`。两个文件**必须在同一目录**——该产物用 `import.meta.url` 推导 webpack publicPath，wasm 放子目录会 404；也不能软链，理由同权重。

**这里必须是真实文件，不能做软链**：Vite 扫描 public 目录时只要发现符号链接就整体放弃（`ERR_SYMLINK_IN_RECURSIVE_READDIR`），`/models/*` 会被 SPA fallback 成 `index.html`，模型只会报一句难懂的解析错误。工作台启动时会先探测 `content-type`，命中 HTML 就直接提示「本地权重未托管」，不再让你猜。

权重目录已在 `.gitignore` 忽略；移动硬盘未挂载或换机器时跑 `bash scripts/fetch-sam-model.sh`：脚本会先把权重下到 `/Volumes/Acer2/Model/slimsam-models` 做缓存（可用 `MODEL_ROOT` 改），再复制进 `web/public/models`。

## 三种输出

| 按钮 | 产物 | 用途 |
| --- | --- | --- |
| 分层导出 | 每个图层一张透明 PNG 节点 + 一对「遮罩标注图 → 补背景节点」 | 做动画：文字/贴纸/人物各自独立位移缩放，原图上的洞交给补背景 |
| 合并导出 | 全部图层并集一张透明 PNG | 只要整体前景 |
| 发送画布 | 「遮罩标注图 → 结果节点」 | 局部重绘：改材质、去掉某元素等 |

「边缘羽化」滑杆（0–8px）把 SAM 的硬二值边转成软 alpha 再导出，数值随节点保存。

## 发送画布为什么不带数字角标

宿主内置的局部遮罩重绘（`canvas-node-mask-edit-dialog` + `maskEditImageNode`）认的是**原图上叠加 `#2563eb` 40% 半透明的标注图**，不是数字角标。因此本插件直接复刻这套契约：

- 用 SAM 算出的精确 mask 渲染成同色同透明度标注图；
- 提示词沿用宿主 `canvas.projectPage.maskPrompt` 模板正文，前缀「参考图片编号」由宿主按入边顺序自动拼接；
- 结果节点入边顺序固定为 **原图 → 标注图**，对应提示词里的图片1/图片2；
- **不代跑生成**：模型与参数由用户在结果节点的内置生图面板里自选。

`@数字` 只是选择器，指代该图层，不进入模型语义；不写 `@` 时所有图层并集成一张遮罩。

## 已知限制

- mask 由官方 `post_process_masks` 还原到原图尺寸，导出时做可分离盒模糊羽化。试过 trimap matting 精修（ViTMatte）但实测比二值基线更差，MODNet 又没有 trimap 输入通道，所以只保留确定性羽化——它消锯齿，但不会凭空生成发丝这类真实半透明细节。
- 文字层按像素分割，不是可编辑文字层（豆包/Lovart 那类会走 OCR），需要改文字内容时建议发画布重绘或另接 OCR。
- 只取第一个上游图片节点作为源图。
