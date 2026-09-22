#!/usr/bin/env bash
# 准备 3D 导演台的静态产物 → web/public/director-desk/。
# 本项目只放插件源码；导演台本体是第三方应用（MIT，lkhxxx123/jlmlh-3d-director），
# 它的 dist/ 在 .gitignore 里（构建产物不入库），换机器时跑本脚本重新生成。
#
# 产物必须落到 web/public 下的**真实文件**：Vite 扫描 public 目录时遇到符号链接会整体放弃。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DEST="$REPO_ROOT/web/public/director-desk"
# 缓存目录：默认用外置盘；没挂载就退回仓库同级，MODEL_ROOT 可覆盖
CACHE_ROOT="${MODEL_ROOT:-/Volumes/Acer2/Model}"
[ -d "$CACHE_ROOT" ] || CACHE_ROOT="${TMPDIR:-/tmp}"
WORK="$CACHE_ROOT/director-desk-src"
SOURCE_URL="${DIRECTOR_DESK_SOURCE:-https://codeload.github.com/lkhxxx123/jlmlh-3d-director/tar.gz/refs/heads/master}"
# 直连 GitHub 不通时用镜像前缀，例如 https://gh-proxy.com/
PROXY="${DIRECTOR_DESK_PROXY:-}"

# 1. 下载源码（首次）并构建。产物目录已存在时直接用，--force 可强制重建。
if [ "${1:-}" = "--force" ] || [ ! -s "$DEST/index.html" ]; then
  if [ ! -f "$WORK/package.json" ]; then
    echo "拉取导演台源码 → ${WORK}"
    mkdir -p "$WORK"
    curl -fL --retry 3 -o "$WORK/src.tgz" "${PROXY}${SOURCE_URL}"
    tar -xzf "$WORK/src.tgz" -C "$WORK" --strip-components=1
  fi
  echo "安装依赖并构建（约 400MB node_modules）"
  (cd "$WORK" && npm install --no-audit --no-fund && npx vite build)
  mkdir -p "$DEST"
  cp -R "$WORK/dist/." "$DEST/"
else
  echo "产物已存在：${DEST}（要重新生成加 --force）"
fi

# 2. 自检：dist 里必须有入口、JS、GLB 模型，缺任一说明构建不完整
for file in index.html models/ue-mannequin-retopology.glb; do
  [ -s "$DEST/$file" ] || { echo "缺少 ${DEST}/${file}，构建不完整" >&2; exit 1; }
done
ls -1 "$DEST"/assets/*.js >/dev/null || { echo "缺少 dist/assets/*.js" >&2; exit 1; }

echo "完成：${DEST}"
echo "提示：导演台源码里的「模型库」引用了作者本机的外部素材目录，这些条目在本项目里会加载失败，不影响摆位/运镜/关键帧/截图。"
