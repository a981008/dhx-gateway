#!/bin/sh
# 停止 DHX Gateway:SIGTERM 优雅退出(等待最多 5 秒),超时强杀。
# 用法: scripts/stop.sh(数据目录用 DSH_DATA 覆盖,默认 <项目根>/data)
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_DATA=${DSH_DATA:-"$PROJECT_ROOT/data"}
PID_FILE="$DSH_DATA/gateway.pid"

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

# 按进程组整杀(setsid 启动的网关 PGID=PID):连带终止全部上游子进程,
# 避免孤儿上游残留并占用 per-user home,导致下次拉起冲突。
kill -- "-$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 50 ]; do
  sleep 0.1
  i=$((i + 1))
done
if kill -0 "$PID" 2>/dev/null; then
  kill -9 -- "-$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
  echo "DHX Gateway force-killed (pid $PID)"
else
  echo "DHX Gateway stopped (pid $PID)"
fi
rm -f "$PID_FILE"
