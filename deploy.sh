#!/usr/bin/env bash
# 部署前端到 GitHub Pages（gh-pages 分支）
# 用法：bash deploy.sh   （需已 git init 并添加 origin 远程）
set -e
cd "$(dirname "$0")"

REPO_URL=$(git config remote.origin.url 2>/dev/null || true)
if [ -z "$REPO_URL" ]; then
  echo "❌ 未找到 git remote origin，请先：git remote add origin git@github.com:用户名/仓库名.git"
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp -r public/. "$TMP/"
touch "$TMP/.nojekyll"

cd "$TMP"
git init -q -b gh-pages
git add -A
git commit -qm "deploy: $(date '+%Y-%m-%d %H:%M:%S')"
git remote add origin "$REPO_URL"
git push -q --force origin gh-pages

# 从仓库 URL 推算站点地址
SITE=$(echo "$REPO_URL" | sed -E 's#.*[:/]([^/]+)/([^/.]+)(\.git)?$#https://\1.github.io/\2/#')
echo "✅ 已部署 → $SITE（Pages 首次启用需等 1~2 分钟）"
