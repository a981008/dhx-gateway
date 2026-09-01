#!/bin/sh
# 停止 DHX Gateway:SIGTERM 优雅退出(等待最多 5 秒),超时强杀。
# 用法: scripts/stop.sh
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)
DSH_HOME=${DSH_HOME_DEPLOY:-"$DSH_CHECKOUT/.dsh-home"}
PID_FILE="$DSH_HOME/gateway.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "DHX Gateway not running (no pid file at $PID_FILE)"
  exit 0
fi
PID=$(cat "$PID_FILE")
if ! kill -0 "$PID" 2>/dev/null; then
  echo "DHX Gateway not running (stale pid $PID)"
  rm -f "$PID_FILE"
  exit 0
fi

kill "$PID"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 50 ]; do
  sleep 0.1
  i=$((i + 1))
done
if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID"
  echo "DHX Gateway force-killed (pid $PID)"
else
  echo "DHX Gateway stopped (pid $PID)"
fi
rm -f "$PID_FILE"
