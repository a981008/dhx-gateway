#!/bin/sh
# 运行独立项目的测试:使用 deepseek-harness 检出内的 vitest。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=${DSH_CHECKOUT:-$(cd "$PROJECT_ROOT/.." && pwd)}
VITEST="$DSH_CHECKOUT/node_modules/.bin/vitest"
if [ ! -x "$VITEST" ]; then
  echo "error: vitest not found at $VITEST — set DSH_CHECKOUT to your deepseek-harness checkout" >&2
  exit 1
fi
cd "$PROJECT_ROOT"
"$VITEST" run --config vitest.config.ts "$@"
