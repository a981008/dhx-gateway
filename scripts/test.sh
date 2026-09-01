#!/bin/sh
# 运行测试套件(vitest)。
# 优先使用项目自身的 vitest;未安装时回退到 deepseek-harness 检出内的工具链。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -x "$PROJECT_ROOT/node_modules/.bin/vitest" ]; then
  VITEST="$PROJECT_ROOT/node_modules/.bin/vitest"
else
  DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)
  VITEST="$DSH_CHECKOUT/node_modules/.bin/vitest"
fi
cd "$PROJECT_ROOT"
"$VITEST" run --config vitest.config.ts "$@"
