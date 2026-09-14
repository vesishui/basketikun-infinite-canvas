#!/usr/bin/env bash
# 准备抠图工作台的 SAM 量化权重（约 13MB）。
# 插件在浏览器里直连 hf-mirror.com 会 Failed to fetch，因此权重必须本地托管到 web/public/models，插件只从本站 /models/ 读。
# 注意：这里必须是真实文件复制，不能软链。Vite 的 public 目录扫描遇到符号链接会直接放弃整个扫描，/models 会被 SPA fallback 成 index.html。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CACHE_ROOT="${MODEL_ROOT:-/Volumes/Acer2/Model/slimsam-models}"
SOURCE_HOST="${SOURCE_HOST:-https://hf-mirror.com}"
MODEL_ID="Xenova/slimsam-77-uniform"
FILES=(config.json preprocessor_config.json quantize_config.json onnx/vision_encoder_quantized.onnx onnx/prompt_encoder_mask_decoder_quantized.onnx)

CACHE="$CACHE_ROOT/$MODEL_ID"
WEB_MODELS="$REPO_ROOT/web/public/models/$MODEL_ID"

# 1. 先下到外部缓存盘，避免每次重装都要走网络
for file in "${FILES[@]}"; do
  target="$CACHE/$file"
  if [ -s "$target" ]; then
    echo "缓存已存在: $file"
    continue
  fi
  mkdir -p "$(dirname "$target")"
  echo "下载: $file"
  curl -fL --retry 3 -o "$target" "${SOURCE_HOST}/${MODEL_ID}/resolve/main/${file}"
done

# 2. 复制进 web/public/models（真实文件，供 Vite 直接托管）
for file in "${FILES[@]}"; do
  target="$WEB_MODELS/$file"
  mkdir -p "$(dirname "$target")"
  cp -f "$CACHE/$file" "$target"
  echo "已就位: web/public/models/$MODEL_ID/$file"
done

echo "完成：$WEB_MODELS"
