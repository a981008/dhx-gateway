#!/bin/sh
# dsh 文件系统围栏补丁管理器(多用户网关部署专用)。
#
# 背景:dsh 的目录浏览(directory-picker browse)与工作区注册
# (WorkspaceRegistry.create)按「单用户本机信任」设计,没有路径边界——
# 登录成员可浏览服务器整个文件系统、把 workspace 注册到任意已存在目录,
# 从而越过网关的用户隔离读到其他成员的目录。本补丁在 dsh 检出中为这两处
# 增加围栏:当上游进程环境带 DSH_HOST_FS_FENCE=<目录> 时,浏览/建目录/
# 注册工作区全部限制在该目录(真实路径比对,软链逃逸同样被拒)之内。
#
# 网关侧(supervisor)已为每个上游注入 DSH_HOST_FS_FENCE = usersRoot/<用户>,
# 即成员只能看到自己专属子树;未注入该变量的部署(普通单机 dsh)行为不变。
#
# 用法:
#   scripts/patch-dsh-fs-fence.sh              应用补丁并重建(幂等;已应用则只确认)
#   scripts/patch-dsh-fs-fence.sh --status     仅报告状态,不做任何修改
#   scripts/patch-dsh-fs-fence.sh --revert     移除补丁并重建(恢复上游行为)
#   scripts/patch-dsh-fs-fence.sh --restart    应用/确认后顺带重启网关
#
# dsh 升级(git pull)后重新执行本脚本即可;上游若改动锚点,脚本会报错
# 并指向源文件,人工确认后再更新锚点。
#
# 环境变量:DSH_CHECKOUT(检出定位)、DSH_PROFILE(--restart 用,默认 gateway)。
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=$(cd "$PROJECT_ROOT" && ./scripts/dsh-checkout.sh)

BROWSE_FILE="$DSH_CHECKOUT/packages/host/directory-picker-browse/src/index.ts"
WORKSPACE_FILE="$DSH_CHECKOUT/packages/workspace/workspace/src/index.ts"
TYPESCRIPT="$DSH_CHECKOUT/node_modules/typescript/bin/tsc"
MARKER='DSH_HOST_FS_FENCE'

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

for f in "$BROWSE_FILE" "$WORKSPACE_FILE"; do
  if [ ! -f "$f" ]; then
    echo "error: 未找到目标文件 $f —— 确认 DSH_CHECKOUT 指向 deepseek-harness 检出" >&2
    exit 1
  fi
done

browse_state() {
  if grep -q "$MARKER" "$BROWSE_FILE"; then echo applied; else echo upstream; fi
}
workspace_state() {
  if grep -q "$MARKER" "$WORKSPACE_FILE"; then echo applied; else echo upstream; fi
}
bundle_state() {
  # browse 的客户端无份(fence 在 host 侧);以 lib/index.js 为产物代表。
  if [ -f "$DSH_CHECKOUT/packages/host/directory-picker-browse/lib/index.js" ] \
    && grep -q "$MARKER" "$DSH_CHECKOUT/packages/host/directory-picker-browse/lib/index.js"; then
    echo patched
  else
    echo plain
  fi
}

report() {
  echo "检出: $DSH_CHECKOUT"
  echo "browse 补丁:   $(browse_state)   (directory-picker-browse/src/index.ts)"
  echo "workspace 补丁: $(workspace_state)   (workspace/workspace/src/index.ts)"
  echo "host 产物:      $(bundle_state)   (directory-picker-browse/lib/index.js)"
}

# ============ 构建(host 侧类型产物 → lib)============
rebuild() {
  echo "==> 刷新类型产物并重建(tsc -b × 2)"
  node "$TYPESCRIPT" -b "$DSH_CHECKOUT/packages/host/directory-picker-browse"
  node "$TYPESCRIPT" -b "$DSH_CHECKOUT/packages/workspace/workspace"
  (cd "$DSH_CHECKOUT/packages/host/directory-picker-browse" && pnpm exec tsdown --env.DSH_BUILD_FACE host)
  (cd "$DSH_CHECKOUT/packages/workspace/workspace" && pnpm exec tsdown --env.DSH_BUILD_FACE host)
}

inject() {
  python3 - "$BROWSE_FILE" "$WORKSPACE_FILE" <<'PYEOF'
import sys
browse_path, workspace_path = sys.argv[1], sys.argv[2]

BROWSE_IMPORTS_OLD = """import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'"""
BROWSE_IMPORTS_NEW = """import { mkdir, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
// Local deployment patch (multi-user gateway): `DSH_HOST_FS_FENCE` confines
// every browse interaction (listing, creation, the default root) inside the
// directory the gateway provisions for the serving user, so a signed-in
// member cannot browse or register paths outside their own subtree.
const FS_FENCE = process.env.DSH_HOST_FS_FENCE

/** Resolve `path` and report whether it stays inside the configured fence. */
async function withinFence(path: string): Promise<boolean> {
  if (FS_FENCE === undefined) return true
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    return false
  }
  const fence = await realpath(FS_FENCE)
  return canonical === fence || canonical.startsWith(`${fence}/`)
}"""
BROWSE_LIST_OLD = """    const home = homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)"""
BROWSE_LIST_NEW = """    const home = FS_FENCE ?? homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)
    // Local deployment patch: refuse levels outside the fence. The canonical
    // (symlink-resolved) form is compared so a link cannot pivot out.
    if (!await withinFence(target)) {
      throw new DirectoryPickerError('directory-unreadable', path ?? target, `cannot list "${path ?? target}": outside the allowed workspace root`)
    }"""
BROWSE_CREATE_OLD = """    const parent = resolve(path)
    // The backend owns segment validation; the Remote controller also refuses
    // invalid wire input, but direct service consumers must hit the same fence."""
BROWSE_CREATE_NEW = """    const parent = resolve(path)
    // Local deployment patch: refuse creation outside the fence.
    if (!await withinFence(parent)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": outside the allowed workspace root`)
    }
    // The backend owns segment validation; the Remote controller also refuses
    // invalid wire input, but direct service consumers must hit the same fence."""
WORKSPACE_IMPORTS_OLD = """import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'"""
WORKSPACE_IMPORTS_NEW = """import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
// Local deployment patch (multi-user gateway): `DSH_HOST_FS_FENCE` confines
// workspace registration inside the directory the gateway provisions for the
// serving user, so a signed-in member cannot point a workspace (and thereby
// agent file access) at another member's subtree or any system path.
const FS_FENCE = process.env.DSH_HOST_FS_FENCE"""
WORKSPACE_CREATE_OLD = """  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }"""
WORKSPACE_CREATE_NEW = """  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    // Local deployment patch: refuse paths outside the fence (symlinks are
    // already resolved by realpathNormalize, so the canonical comparison is
    // the whole fact).
    if (FS_FENCE !== undefined) {
      const fence = await realpath(FS_FENCE)
      if (canonical !== fence && !canonical.startsWith(`${fence}/`)) {
        throw new Error(`cannot create a workspace at '${canonical}': outside the allowed workspace root`)
      }
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }"""

def apply(path, pairs):
    text = open(path).read()
    for old, new in pairs:
        n = text.count(old)
        if n != 1:
            print(f'error: 锚点在 {path} 中出现 {n} 次(期望 1);上游可能已改动,拒绝盲改: {old[:60]}...', file=sys.stderr)
            sys.exit(1)
        text = text.replace(old, new)
    open(path, 'w').write(text)

apply(browse_path, [
    (BROWSE_IMPORTS_OLD, BROWSE_IMPORTS_NEW),
    (BROWSE_LIST_OLD, BROWSE_LIST_NEW),
    (BROWSE_CREATE_OLD, BROWSE_CREATE_NEW),
])
apply(workspace_path, [
    (WORKSPACE_IMPORTS_OLD, WORKSPACE_IMPORTS_NEW),
    (WORKSPACE_CREATE_OLD, WORKSPACE_CREATE_NEW),
])
print('已注入 browse 与 workspace 围栏补丁')
PYEOF
}

remove() {
  :  # revert 分支内置还原体;此函数仅为占位保留结构
}

case "$MODE" in
  status)
    report
    exit 0
    ;;
  revert)
    python3 - "$BROWSE_FILE" "$WORKSPACE_FILE" <<'PYEOF'
import sys
browse_path, workspace_path = sys.argv[1], sys.argv[2]

BROWSE_IMPORTS_NEW = """import { mkdir, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
// Local deployment patch (multi-user gateway): `DSH_HOST_FS_FENCE` confines
// every browse interaction (listing, creation, the default root) inside the
// directory the gateway provisions for the serving user, so a signed-in
// member cannot browse or register paths outside their own subtree.
const FS_FENCE = process.env.DSH_HOST_FS_FENCE

/** Resolve `path` and report whether it stays inside the configured fence. */
async function withinFence(path: string): Promise<boolean> {
  if (FS_FENCE === undefined) return true
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    return false
  }
  const fence = await realpath(FS_FENCE)
  return canonical === fence || canonical.startsWith(`${fence}/`)
}"""
BROWSE_IMPORTS_OLD = """import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'"""
BROWSE_LIST_NEW = """    const home = FS_FENCE ?? homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)
    // Local deployment patch: refuse levels outside the fence. The canonical
    // (symlink-resolved) form is compared so a link cannot pivot out.
    if (!await withinFence(target)) {
      throw new DirectoryPickerError('directory-unreadable', path ?? target, `cannot list "${path ?? target}": outside the allowed workspace root`)
    }"""
BROWSE_LIST_OLD = """    const home = homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)"""
BROWSE_CREATE_NEW = """    const parent = resolve(path)
    // Local deployment patch: refuse creation outside the fence.
    if (!await withinFence(parent)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": outside the allowed workspace root`)
    }
    // The backend owns segment validation; the Remote controller also refuses
    // invalid wire input, but direct service consumers must hit the same fence."""
BROWSE_CREATE_OLD = """    const parent = resolve(path)
    // The backend owns segment validation; the Remote controller also refuses
    // invalid wire input, but direct service consumers must hit the same fence."""
WORKSPACE_IMPORTS_NEW = """import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
// Local deployment patch (multi-user gateway): `DSH_HOST_FS_FENCE` confines
// workspace registration inside the directory the gateway provisions for the
// serving user, so a signed-in member cannot point a workspace (and thereby
// agent file access) at another member's subtree or any system path.
const FS_FENCE = process.env.DSH_HOST_FS_FENCE"""
WORKSPACE_IMPORTS_OLD = """import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'"""
WORKSPACE_CREATE_NEW = """  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    // Local deployment patch: refuse paths outside the fence (symlinks are
    // already resolved by realpathNormalize, so the canonical comparison is
    // the whole fact).
    if (FS_FENCE !== undefined) {
      const fence = await realpath(FS_FENCE)
      if (canonical !== fence && !canonical.startsWith(`${fence}/`)) {
        throw new Error(`cannot create a workspace at '${canonical}': outside the allowed workspace root`)
      }
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }"""
WORKSPACE_CREATE_OLD = """  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }"""

def apply(path, pairs):
    text = open(path).read()
    for old, new in pairs:
        n = text.count(old)
        if n != 1:
            print(f'error: 补丁块在 {path} 中出现 {n} 次(期望 1);补丁不完整或上游已改动,拒绝盲删', file=sys.stderr)
            sys.exit(1)
        text = text.replace(old, new)
    open(path, 'w').write(text)

apply(browse_path, [
    (BROWSE_IMPORTS_NEW, BROWSE_IMPORTS_OLD),
    (BROWSE_LIST_NEW, BROWSE_LIST_OLD),
    (BROWSE_CREATE_NEW, BROWSE_CREATE_OLD),
])
apply(workspace_path, [
    (WORKSPACE_IMPORTS_NEW, WORKSPACE_IMPORTS_OLD),
    (WORKSPACE_CREATE_NEW, WORKSPACE_CREATE_OLD),
])
print('已还原 browse 与 workspace 为上游原始代码')
PYEOF
    rebuild
    echo "==> 已还原上游行为并重建完成"
    exit 0
    ;;
esac

# ============ apply(默认)=
B_STATE=$(browse_state)
W_STATE=$(workspace_state)
if [ "$B_STATE" = "applied" ] && [ "$W_STATE" = "applied" ]; then
  echo "==> 围栏补丁已存在,跳过注入"
elif [ "$B_STATE" = "upstream" ] && [ "$W_STATE" = "upstream" ]; then
  inject
elif [ "$B_STATE" = "unknown" ] || [ "$W_STATE" = "unknown" ]; then
  echo "error: 补丁状态不一致或无法识别,拒绝操作;请人工检查" >&2
  exit 1
else
  echo "error: 两个补丁文件状态不一致(browse=$B_STATE workspace=$W_STATE),请先用 --revert 或人工对齐" >&2
  exit 1
fi

rebuild

echo "==> 完成。host 产物状态: $(bundle_state)"
if [ -n "$RESTART" ]; then
  echo "==> 重启网关(上游下次访问时以带围栏的环境拉起)"
  "$PROJECT_ROOT/scripts/stop.sh"
  "$PROJECT_ROOT/scripts/start.sh"
else
  echo "提示:执行 scripts/stop.sh && scripts/start.sh 重启网关后生效"
fi
