#!/bin/sh
# 启动 DHX Gateway(后台守护运行)。
# 用法: scripts/start.sh
# 环境变量(均有默认值,见下;启动子进程时仍以内部 DSH_HOME 指向该目录):
#   DSH_CHECKOUT  deepseek-harness 检出根;默认从脚本位置推断(项目位于检出内时)
#   DSH_HOME_DEPLOY 网关数据主目录;默认 <DSH_CHECKOUT>/.dsh-home(变量名避开 harness 自身的 DSH_HOME)
#   DSH_PROFILE   profile 名;默认 gateway
# 日志: <DSH_HOME>/gateway.log   PID: <DSH_HOME>/gateway.pid
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)
DSH_HOME=${DSH_HOME_DEPLOY:-"$DSH_CHECKOUT/.dsh-home"}
DSH_PROFILE=${DSH_PROFILE:-gateway}
PID_FILE="$DSH_HOME/gateway.pid"
LOG_FILE="$DSH_HOME/gateway.log"
mkdir -p "$DSH_HOME"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "DHX Gateway already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

# 启动方式:优先已安装的 dsh 命令;检出源码环境用 tsx 源启动。
if [ -f "$DSH_CHECKOUT/apps/cli/src/bin.ts" ]; then
  cd "$DSH_CHECKOUT"
  set -- node --import tsx/esm apps/cli/src/bin.ts --profile "$DSH_PROFILE"
elif command -v dsh >/dev/null 2>&1; then
  set -- dsh --profile "$DSH_PROFILE"
else
  echo "error: no launch method found — set DSH_CHECKOUT to the deepseek-harness checkout, or install dsh on PATH" >&2
  exit 1
fi

DSH_HOME="$DSH_HOME" nohup "$@" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "DHX Gateway started (pid $(cat "$PID_FILE")), profile $DSH_PROFILE, log $LOG_FILE"
