# 脚本一览

> 覆盖:`scripts/` 全部脚本的用途、公共行为与环境变量。
> 上游:[README](../README.md) · 相邻:[运维](operations.md)(数据布局与启停) · [配置参考](configuration.md)(插件配置字段)

`scripts/` 下全部脚本均为 POSIX sh,可在任意目录执行(内部按脚本自身位置定位项目根):

| 脚本 | 用途 | 典型用法 |
| --- | --- | --- |
| `patch-dsh-settings.sh` | **dsh 设置页补丁管理器**(多用户网关部署):在 dsh 检出的 `packages/client/connection` 客户端 fence 注入 `DSH_CLIENT_TRUST_ANY_PAGE` 构建期开关并重建 bundle,使局域网地址下设置页可用;幂等(重复执行不重复注入),上游改了锚点行会报错拒改;`--status` 只读检查,`--revert` 还原上游行为,`--restart` 应用后顺带重启网关。**dsh 升级后需重跑** | `./scripts/patch-dsh-settings.sh`、`./scripts/patch-dsh-settings.sh --status` |
| `patch-dsh-fs-fence.sh` | **dsh 文件系统围栏补丁管理器**(多用户网关部署):在 dsh 检出中为目录浏览(directory-picker browse)与工作区注册(WorkspaceRegistry.create)加围栏 —— 上游进程环境带 `DSH_HOST_FS_FENCE=<目录>` 时,浏览/建目录/注册工作区一律限制在该目录内(真实路径比对,软链逃逸同样被拒),成员只能看到自己专属子树;未注入该变量的普通 dsh 部署行为不变。幂等;上游改锚点即报错拒改;`--status` 只读检查、`--revert` 还原、`--restart` 应用后重启网关。**dsh 升级后需重跑** | `./scripts/patch-dsh-fs-fence.sh`、`./scripts/patch-dsh-fs-fence.sh --status` |
| `patch-dsh-fs-fence.sh` | **dsh 文件系统围栏补丁管理器**(多用户网关部署):在 dsh 检出中为目录浏览(directory-picker browse)与工作区注册(WorkspaceRegistry.create)加围栏 —— 上游进程环境带 `DSH_HOST_FS_FENCE=<目录>` 时,浏览/建目录/注册工作区一律限制在该目录内(真实路径比对,软链逃逸同样被拒);未注入该变量的普通 dsh 部署行为不变。幂等;上游改锚点即报错拒改;`--status` 只读检查、`--revert` 还原、`--restart` 应用后重启网关。**dsh 升级后需重跑** | `./scripts/patch-dsh-fs-fence.sh`、`./scripts/patch-dsh-fs-fence.sh --status` |
| `deploy.sh` | **一键部署(新机器/远程)**:装依赖 → 构建 → 创建 profile → 写组合 patch → 启动,等价快速开始的第 2–4 步;幂等,已存在的 profile 与 `cordis.patch.yml` 不会被覆盖。参数:`--host 0.0.0.0\|127.0.0.1`、`--port N`、`--public-origin URL`、`--dsh-home DIR`、`--no-start` | `./scripts/deploy.sh`、`./scripts/deploy.sh --port 9000 --public-origin https://dsh.example.com --no-start` |
| `build.sh` | 编译 `src/` → `lib/`(tsc)。首次部署、每次改码后执行 | `./scripts/build.sh` |
| `test.sh` | 运行完整测试套件(vitest,105 个用例);参数直通 vitest | `./scripts/test.sh`、过滤:`./scripts/test.sh -t store` |
| `start.sh` | 后台守护启动网关;写 PID 文件与日志;重复执行安全(已运行则原样退出) | `./scripts/start.sh` |
| `stop.sh` | 停止网关:SIGTERM 优雅退出,最多等 5 秒后 SIGKILL;自动清理陈旧 PID | `./scripts/stop.sh` |
| `setup-deps.sh` | 把 `link:` 依赖绑定到指定检出并安装 `node_modules`(首次部署或检出换位后执行一次) | `DSH_CHECKOUT=~/git/deepseek-harness ./scripts/setup-deps.sh` |
| `dsh-checkout.sh` | 内部辅助:定位并打印检出根,供其余脚本共用;一般不直接调用 | — |
| `dsh-web-upstream.sh` | 启动一个用户上游 `dsh web`:先 cd 到检出根再按与 `start.sh` 相同的方式拉起,保证源码运行时模块解析不依赖子进程 cwd;供 `dshCommand` 引用 | `dshCommand: ['<项目根>/scripts/dsh-web-upstream.sh', 'web']` |

## 公共行为

- **检出定位**(所有脚本共用):依次探测 `DSH_CHECKOUT` 环境变量 → 项目父目录(项目在检出内的布局) → 兄弟目录 `../deepseek-harness`(标准布局);全部失败则报错并要求显式指定 `DSH_CHECKOUT`。
- **工具链优先级**(`build.sh`/`test.sh`):优先项目自身 `node_modules/.bin/` 的 tsc/vitest;未安装时回退到检出内的同名工具。

## 环境变量

| 变量 | 作用于 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DSH_CHECKOUT` | 全部 | 自动定位(见上) | deepseek-harness 检出根 |
| `DSH_DATA` | `start.sh` / `stop.sh` / `deploy.sh` | `<项目根>/data` | 网关数据与运行档案目录(gateway.log / gateway.pid / 默认 stateRoot)。变量名避开 harness 自身的 `DSH_HOME` |
| `DSH_HOME` | `start.sh` / `deploy.sh` | `<DSH_CHECKOUT>/.dsh-home` | 传给网关进程的 dsh 主目录(profiles 所在,属 dsh 侧);`deploy.sh` 用它创建/定位 profile,与启动保持同源。外层已导出的 `DSH_HOME`(如 dsh 桌面端)若不含对应 profile,启动脚本自动忽略并回退默认值;要刻意使用非默认主目录时才需显式设置 |
| `DSH_PROFILE` | `start.sh` / `deploy.sh` | `gateway` | 要启动/部署的 profile 名 |

## 启动方式与产物

- `start.sh` 的启动方式:存在 `<DSH_CHECKOUT>/apps/cli/src/bin.ts` 时用 `node --import tsx/esm` 源启动;否则若 `dsh` 在 PATH 上则用 `dsh --profile <name>`;两者皆无时报错退出。
- 日志追加到 `<DSH_DATA>/gateway.log`;PID 写入 `<DSH_DATA>/gateway.pid`;`stop.sh` 只读同一 `DSH_DATA`。
- SIGTERM 会触发网关的完整回收:停止所有用户上游进程、落盘状态后再退出。
- `setup-deps.sh` 把全部 link 目标按指定检出的**相对路径**改写(`package.json` 保持可提交),并校验每个目标确为检出内的包,然后 `pnpm install --prod`。
