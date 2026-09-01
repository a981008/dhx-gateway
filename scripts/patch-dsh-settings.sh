#!/bin/sh
# dsh 设置页回环栅栏补丁管理器(多用户网关部署专用)。
#
# 背景:dsh 客户端默认只允许回环页面(localhost/127.*)进入设置面(设置文档
# 含凭据);网关场景下同事从局域网地址访问,设置页报
# 「settings are unavailable in this browser」。本补丁在 dsh 检出的
# packages/client/connection 客户端 fence 中增加一个构建期开关分支:
#   process.env.DSH_CLIENT_TRUST_ANY_PAGE === '1'
# 构建客户端 bundle 时注入该变量即放开栅栏;安全兜底(/api Host 栅栏、
# trustedHosts、浏览器认证)不受影响。
#
# 用法:
#   scripts/patch-dsh-settings.sh              应用补丁并重建(幂等;已应用则只确认)
#   scripts/patch-dsh-settings.sh --status     仅报告状态,不做任何修改
#   scripts/patch-dsh-settings.sh --revert     移除补丁并重建(恢复上游行为)
#   scripts/patch-dsh-settings.sh --restart    应用/确认后顺带重启网关
#
# dsh 升级(git pull)后重新执行本脚本即可;上游若改动了锚点行,脚本会报错
# 并指向源文件,人工确认后再更新锚点。
#
# 环境变量:DSH_CHECKOUT(检出定位)、DSH_PROFILE(--restart 用,默认 gateway)。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)

TARGET_FILE="$DSH_CHECKOUT/packages/client/connection/src/client/index.ts"
BUNDLE_FILE="$DSH_CHECKOUT/packages/client/connection/lib/client.js"
TYPESCRIPT="$DSH_CHECKOUT/node_modules/typescript/bin/tsc"

# 锚点(上游原始行)与补丁体。改锚点必须同步改 UPSTREAM_LINE 的还原形态。
MARKER='DSH_CLIENT_TRUST_ANY_PAGE'
UPSTREAM_LINE='    isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),'

MODE=apply
RESTART=
for arg in "$@"; do
  case "$arg" in
    --status) MODE=status;;
    --revert) MODE=revert;;
    --restart) RESTART=1;;
    *) echo "error: 未知参数 $arg;可用:--status / --revert / --restart" >&2; exit 1;;
  esac
done

if [ ! -f "$TARGET_FILE" ]; then
  echo "error: 未找到目标文件 $TARGET_FILE —— 确认 DSH_CHECKOUT 指向 deepseek-harness 检出" >&2
  exit 1
fi

source_state() {
  if grep -q "$MARKER" "$TARGET_FILE"; then echo applied
  elif grep -qF 'isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname' "$TARGET_FILE"; then echo upstream
  else echo unknown; fi
}

bundle_state() {
  # 已重建且带开关:isLoopback 表达式中出现「|| true」(define 内联后的残形)
  if [ -f "$BUNDLE_FILE" ] && grep -q 'ownsHost === true || pageLocation === void 0 || true' "$BUNDLE_FILE"; then echo patched
  elif [ -f "$BUNDLE_FILE" ]; then echo plain
  else echo missing; fi
}

report() {
  echo "检出: $DSH_CHECKOUT"
  echo "源码补丁: $(source_state)   (src/client/index.ts)"
  echo "bundle:   $(bundle_state)   (lib/client.js)"
}

# ============ 构建(类型产物 → 客户端 bundle,注入开关)============
rebuild() {
  echo "==> 刷新类型产物(tsc -b)"
  node "$TYPESCRIPT" -b "$DSH_CHECKOUT/packages/client/connection/tsconfig.client.json"
  echo "==> 重建客户端 bundle(tsdown,注入 DSH_CLIENT_TRUST_ANY_PAGE=1)"
  (cd "$DSH_CHECKOUT/packages/client/connection" \
    && DSH_CLIENT_TRUST_ANY_PAGE=1 pnpm exec tsdown --env.DSH_BUILD_FACE client)
}

case "$MODE" in
  status)
    report
    exit 0
    ;;
  revert)
    STATE=$(source_state)
    if [ "$STATE" = "upstream" ]; then
      echo "源码本就是上游原始状态,无需还原"
    elif [ "$STATE" = "applied" ]; then
      python3 - "$TARGET_FILE" <<'PYEOF'
import sys
path = sys.argv[1]
text = open(path).read()
patched = '''    // Local deployment patch (multi-user gateway): `DSH_CLIENT_TRUST_ANY_PAGE=1`
    // at client-bundle build time serves the privileged surface (settings,
    // credentials) from any page authority. The gateway serves the app from a
    // LAN address, where upstream's loopback-only gate made the settings page
    // permanently unavailable; the /api Host fence, trustedHosts, and browser
    // authentication still protect every RPC. Drop the env to restore the
    // upstream loopback-only policy.
    isLoopback: transport?.ownsHost === true || pageLocation === undefined
      || process.env.DSH_CLIENT_TRUST_ANY_PAGE === '1'
      || isLoopbackHostname(pageLocation.hostname),'''
upstream = '''    isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),'''
if patched not in text:
    print('error: 补丁块不完整或已被上游改动,拒绝盲删;请人工检查 ' + path, file=sys.stderr)
    sys.exit(1)
open(path, 'w').write(text.replace(patched, upstream))
print('已还原为上游原始行')
PYEOF
    else
      echo "error: 源码状态未知(既非补丁也非上游原始行),拒绝操作;请人工检查 $TARGET_FILE" >&2
      exit 1
    fi
    rebuild
    echo "==> 已还原上游行为并重建完成"
    exit 0
    ;;
esac

# ============ apply(默认)=
STATE=$(source_state)
case "$STATE" in
  applied)
    echo "==> 源码补丁已存在,跳过注入"
    ;;
  upstream)
    python3 - "$TARGET_FILE" <<'PYEOF'
import sys
path = sys.argv[1]
text = open(path).read()
upstream = '''    isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),'''
patched = '''    // Local deployment patch (multi-user gateway): `DSH_CLIENT_TRUST_ANY_PAGE=1`
    // at client-bundle build time serves the privileged surface (settings,
    // credentials) from any page authority. The gateway serves the app from a
    // LAN address, where upstream's loopback-only gate made the settings page
    // permanently unavailable; the /api Host fence, trustedHosts, and browser
    // authentication still protect every RPC. Drop the env to restore the
    // upstream loopback-only policy.
    isLoopback: transport?.ownsHost === true || pageLocation === undefined
      || process.env.DSH_CLIENT_TRUST_ANY_PAGE === '1'
      || isLoopbackHostname(pageLocation.hostname),'''
if text.count(upstream) != 1:
    print('error: 上游锚点行出现次数 != 1(可能上游已改动该逻辑),拒绝盲改;请人工检查 ' + path, file=sys.stderr)
    sys.exit(1)
open(path, 'w').write(text.replace(upstream, patched))
print('已注入补丁分支')
PYEOF
    ;;
  unknown)
    echo "error: 源码既无补丁也匹配不到上游锚点行 —— 上游可能已重构此处;请人工检查 $TARGET_FILE 后更新本脚本锚点" >&2
    exit 1
    ;;
esac

rebuild

echo "==> 完成。bundle 状态: $(bundle_state)"
if [ -n "$RESTART" ]; then
  echo "==> 重启网关(上游下次访问时以新 bundle 拉起)"
  "$PROJECT_ROOT/scripts/stop.sh"
  "$PROJECT_ROOT/scripts/start.sh"
else
  echo "提示:执行 scripts/stop.sh && scripts/start.sh 重启网关后生效(浏览器需强刷)"
fi
