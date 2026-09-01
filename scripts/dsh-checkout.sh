#!/bin/sh
# Locate the deepseek-harness checkout (printed on stdout).
# Order: $DSH_CHECKOUT, the parent directory (project inside the checkout),
# then ../deepseek-harness (canonical sibling layout).
if [ -n "$DSH_CHECKOUT" ]; then
  echo "$DSH_CHECKOUT"
  exit 0
fi
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -f "$PROJECT_ROOT/../apps/cli/src/bin.ts" ]; then
  cd "$PROJECT_ROOT/.." && pwd
elif [ -f "$PROJECT_ROOT/../deepseek-harness/apps/cli/src/bin.ts" ]; then
  cd "$PROJECT_ROOT/../deepseek-harness" && pwd
else
  echo "error: 无法定位 deepseek-harness 检出根;请设置 DSH_CHECKOUT" >&2
  exit 1
fi
