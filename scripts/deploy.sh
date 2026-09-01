#!/bin/sh
# 一键部署 DHX Gateway(新机器/远程):装依赖 → 构建 → 创建 profile → 写组合 patch → 启动。
# 用法: scripts/deploy.sh [--host 0.0.0.0|127.0.0.1] [--port 8080]
#                [--public-origin URL] [--dsh-home DIR] [--no-start]
# 幂等:每一步都可安全重复;已存在的 profile 与 cordis.patch.yml 不会被覆盖。
# 环境变量:DSH_CHECKOUT(检出定位)、DSH_PROFILE(profile 名,默认 gateway);
# 详见 docs/scripts.md 的环境变量表。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)
DSH_PROFILE=${DSH_PROFILE:-gateway}

HOST=0.0.0.0
PORT=8080
PUBLIC_ORIGIN=
CUSTOM_DSH_HOME=
NO_START=

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --public-origin) PUBLIC_ORIGIN=$2; shift 2;;
    --dsh-home) CUSTOM_DSH_HOME=$2; shift 2;;
    --no-start) NO_START=1; shift;;
    *) echo "error: 未知参数 $1;用法见文件头注释" >&2; exit 1;;
  esac
done

case "$HOST" in
  0.0.0.0|127.0.0.1) ;;
  *) echo "error: --host 仅支持 0.0.0.0(局域网)或 127.0.0.1(仅本机)" >&2; exit 1;;
esac
case "$PORT" in
  ''|*[!0-9]*) echo "error: --port 必须是纯数字" >&2; exit 1;;
esac
if [ -n "$PUBLIC_ORIGIN" ]; then
  case "$PUBLIC_ORIGIN" in
    http://*|https://*) ;;
    *) echo "error: --public-origin 必须是 http(s) 绝对 origin(不带路径)" >&2; exit 1;;
  esac
fi

# Node 版本要求(README 环境要求:^22.19 || >=24)
if ! command -v node >/dev/null 2>&1; then
  echo "error: 未找到 node" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  echo "error: 需要 Node.js ^22.19 或 >=24,当前 $(node -p 'process.versions.node')" >&2
  exit 1
fi

# DSH_HOME 与启动/创建保持同源:start.sh 默认也是检出内主目录
DSH_HOME=${CUSTOM_DSH_HOME:-"$DSH_CHECKOUT/.dsh-home"}
export DSH_HOME
PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

echo "==> [1/5] 安装项目依赖"
if [ -d "$PROJECT_ROOT/node_modules" ]; then
  echo "    node_modules 已存在,跳过(检出换位后请运行 scripts/setup-deps.sh 重绑)"
else
  DSH_CHECKOUT="$DSH_CHECKOUT" "$PROJECT_ROOT/scripts/setup-deps.sh"
fi

echo "==> [2/5] 构建 lib/"
"$PROJECT_ROOT/scripts/build.sh"

echo "==> [3/5] 创建 profile \"$DSH_PROFILE\"(DSH_HOME=$DSH_HOME)"
if [ -f "$PROFILE_DIR/package.json" ]; then
  echo "    profile 已存在,跳过"
else
  mkdir -p "$DSH_HOME"
  # 与 start.sh 相同的启动优先级:检出源码优先,否则用 PATH 上的 dsh
  if [ -f "$DSH_CHECKOUT/apps/cli/src/bin.ts" ]; then
    (cd "$DSH_CHECKOUT" && node --import tsx/esm apps/cli/src/bin.ts plugin --profile "$DSH_PROFILE" add "$PROJECT_ROOT")
  else
    dsh plugin --profile "$DSH_PROFILE" add "$PROJECT_ROOT"
  fi
fi

echo "==> [4/5] 写组合 patch"
if [ -f "$PATCH_FILE" ]; then
  echo "    cordis.patch.yml 已存在,保持不动:$PATCH_FILE"
else
  # 检出源码运行必须用包装脚本(绝对路径;路径含引号不受支持),正式安装用 dsh 命令
  if [ -f "$DSH_CHECKOUT/apps/cli/src/bin.ts" ]; then
    DSH_COMMAND="['$PROJECT_ROOT/scripts/dsh-web-upstream.sh', 'web']"
  else
    DSH_COMMAND="['dsh', 'web']"
  fi
  {
    echo "- insert:"
    echo "    - id: webserver"
    echo "      name: '@deepseek-ai/dsh-host-webserver'"
    echo "      config:"
    echo "        host: $HOST"
    echo "        port: $PORT"
    echo "        compression: none"
    echo "    - id: dhx-gateway"
    echo "      name: 'dhx-gateway'"
    echo "      config:"
    echo "        dshCommand: $DSH_COMMAND"
    if [ -n "$PUBLIC_ORIGIN" ]; then
      echo "        publicOrigin: '$PUBLIC_ORIGIN'"
    fi
    echo "        startTimeoutMs: 60000"
  } > "$PATCH_FILE"
  echo "    已写入:$PATCH_FILE"
fi

echo "==> [5/5] 启动网关"
if [ -n "$NO_START" ]; then
  echo "    --no-start:跳过启动"
else
  START_OUTPUT=$("$PROJECT_ROOT/scripts/start.sh")
  echo "$START_OUTPUT"
  LOG_FILE="${DSH_DATA:-$PROJECT_ROOT/data}/gateway.log"
  case "$START_OUTPUT" in
    *"already running"*)
      echo "    网关原本就在运行;直接访问 http://<这台机器的地址>:$PORT/"
      ;;
    *)
      sleep 5
      if grep -q 'bootstrap invite' "$LOG_FILE" 2>/dev/null; then
        echo "    首次部署 —— 引导邀请(选同事实际访问地址的那条,打开即建管理员):"
        grep 'bootstrap invite' "$LOG_FILE" | tail -5 | sed 's/^/    /'
        grep 'pick the address' "$LOG_FILE" | tail -1 | sed 's/^/    /'
      else
        echo "    账号库已有用户,直接访问 http://<这台机器的地址>:$PORT/ 登录"
      fi
      ;;
  esac
fi

echo "==> 完成。日志: ${DSH_DATA:-$PROJECT_ROOT/data}/gateway.log  停止: scripts/stop.sh"
