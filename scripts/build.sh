#!/bin/sh
# 构建独立项目:用 deepseek-harness 检出内的 tsc 编译 src → lib。
# 项目位于检出内时自动定位检出根;否则用环境变量 DSH_CHECKOUT 指定。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=${DSH_CHECKOUT:-$(cd "$PROJECT_ROOT/.." && pwd)}
TSC="$DSH_CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "error: tsc not found at $TSC — set DSH_CHECKOUT to your deepseek-harness checkout" >&2
  exit 1
fi
"$TSC" -p "$PROJECT_ROOT/tsconfig.json"
echo "built: $PROJECT_ROOT/lib"
