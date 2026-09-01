#!/bin/sh
# 构建独立项目:src → lib(tsc)。
# 优先使用项目自身的 typescript;未安装时回退到 deepseek-harness 检出内的工具链。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -x "$PROJECT_ROOT/node_modules/.bin/tsc" ]; then
  TSC="$PROJECT_ROOT/node_modules/.bin/tsc"
else
  DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)
  TSC="$DSH_CHECKOUT/node_modules/.bin/tsc"
fi
"$TSC" -p "$PROJECT_ROOT/tsconfig.json"
echo "built: $PROJECT_ROOT/lib"
