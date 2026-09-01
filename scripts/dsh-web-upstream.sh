#!/bin/sh
# 启动一个用户上游 `dsh web`(供 dshCommand 使用,网关会追加 --host/--port/--no-open)。
# 用法: scripts/dsh-web-upstream.sh web
#
# 为什么需要包装:supervisor 以「用户工作区」为 cwd 拉起子进程,而 tsx 按 cwd
# 向上查找 tsconfig 来应用 paths 映射 —— 从用户工作区向上找到的是本项目的
# tsconfig(没有 @deepseek-ai/* 的 paths),`@deepseek-ai/cordis` 会解析到检出内
# vendor 的预构建产物,其导出与源码不同步,上游启动即崩(报 `does not provide
# an export named ...`)。这里先 cd 到检出根再启动,与 start.sh 启动网关的方式
# 一致,保证模块解析永远走检出的 tsconfig paths。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)
cd "$DSH_CHECKOUT"

# 启动方式与 start.sh 保持一致:检出源码用 node --import tsx/esm;否则用 PATH 上的 dsh。
if [ -f "$DSH_CHECKOUT/apps/cli/src/bin.ts" ]; then
  exec node --import tsx/esm "$DSH_CHECKOUT/apps/cli/src/bin.ts" "$@"
elif command -v dsh >/dev/null 2>&1; then
  exec dsh "$@"
else
  echo "error: no launch method found — set DSH_CHECKOUT to the deepseek-harness checkout, or install dsh on PATH" >&2
  exit 1
fi
