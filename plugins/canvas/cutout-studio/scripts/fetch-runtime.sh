#!/usr/bin/env bash
# 准备抠图工作台的前端运行时：transformers.js（888KB）+ onnxruntime WASM（21MB）。
# 之前插件直连 cdn.jsdelivr 拉 ESM，代理一关就整个不可用；权重已本地化，运行时没理由还留在外网。
# npm 只用来取产物，产物必须以真实文件复制进 web/public/vendor（Vite 的 public 扫描遇到符号链接会整体放弃扫描）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CACHE_ROOT="${MODEL_ROOT:-/Volumes/Acer2/Model/slimsam-models}"
PKG="@huggingface/transformers@3"
DIST="$CACHE_ROOT/npm-runtime/node_modules/@huggingface/transformers/dist"
VENDOR="$REPO_ROOT/web/public/vendor"

if [ ! -s "$DIST/transformers.min.js" ]; then
  echo "拉取 $PKG 到缓存: $CACHE_ROOT/npm-runtime"
  mkdir -p "$CACHE_ROOT/npm-runtime"
  (cd "$CACHE_ROOT/npm-runtime" && npm init -y >/dev/null && npm i --no-audit --no-fund --silent "$PKG")
fi

# wasm 必须和 transformers.min.js 同目录：该产物用 import.meta.url 推导 webpack publicPath，分开放会 404
mkdir -p "$VENDOR"
for file in transformers.min.js ort-wasm-simd-threaded.jsep.wasm ort-wasm-simd-threaded.jsep.mjs; do
  cp -f "$DIST/$file" "$VENDOR/$file"
  echo "已就位: web/public/vendor/$file"
done

# 自检：被 Vite 回落成 HTML 的话，插件只会报一句难懂的解析失败
if curl -fsS -m 5 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
  for file in transformers.min.js ort-wasm-simd-threaded.jsep.wasm; do
    echo "本地托管检查: /vendor/$file -> $(curl -sS -m 10 -o /dev/null -w '%{content_type}' "http://127.0.0.1:3000/vendor/$file")"
  done
else
  echo "dev server 未启动，跳过托管检查（启动后插件加载失败会提示「本地资源未托管」）"
fi
