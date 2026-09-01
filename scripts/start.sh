#!/bin/sh
# 启动 DHX Gateway(后台守护运行)。
# 用法: scripts/start.sh
# 环境变量(均有默认值,见下):
#   DSH_CHECKOUT  deepseek-harness 检出根;由 dsh-checkout.sh 自动定位
#   DSH_DATA      网关数据与运行档案目录;默认 <项目根>/data
#   DSH_HOME      传给网关进程的 dsh 主目录(profiles 所在,属 dsh 侧);
#                 默认 <DSH_CHECKOUT>/.dsh-home。注意:外层环境若已导出 DSH_HOME
#                 (例如 dsh 桌面端),必须在此显式覆盖,否则 profile 会找不到。
#   DSH_PROFILE   profile 名;默认 gateway
# 日志: <DSH_DATA>/gateway.log   PID: <DSH_DATA>/gateway.pid
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)
DSH_DATA=${DSH_DATA:-"$PROJECT_ROOT/data"}
# 防线:外层环境若已导出 DSH_HOME(例如 dsh 桌面端指向 ~/.dsh),而该目录里
# 并没有本项目要用的 gateway profile,启动必然失败(profile does not exist)。
# 此时忽略外层值、落回检出内主目录,除非那里确实存在对应 profile。
if [ -n "${DSH_HOME:-}" ] && [ ! -d "$DSH_HOME/profiles/$DSH_PROFILE" ]; then
  DSH_HOME=""
fi
DSH_HOME=${DSH_HOME:-"$DSH_CHECKOUT/.dsh-home"}
DSH_PROFILE=${DSH_PROFILE:-gateway}
PID_FILE="$DSH_DATA/gateway.pid"
LOG_FILE="$DSH_DATA/gateway.log"
mkdir -p "$DSH_DATA"

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
