# AGENTS.md

面向在本仓库工作的编码代理(以及人类贡献者)。项目定位与使用方式见 [README](README.md);本文件只列「改代码前必须知道的契约与规则」。

## 一句话

dsh(DeepSeek Harness)的多用户网关 cordis 插件:邀请码账号 + HMAC 签名会话 + 每用户独立 `dsh web` 上游 + 流式代理。npm 包名 `dhx-gateway`,cordis 插件名 `dhx-gateway`,会话 Cookie 名 `dhxgw_session`。

## 布局

| 路径 | 内容 | 入库 |
| --- | --- | --- |
| `src/` | 14 个模块:config/index/invariant/origin/pages/password/proxy/routes/secret/session-cookie/store/supervisor/upgrade/upstream-jar | 是 |
| `tests/` | 15 个 spec + `fixtures/fake-dsh-web.mjs`(105 个用例,vitest) | 是 |
| `scripts/` | 10 个 POSIX sh:build / test / setup-deps / start / stop / dsh-checkout / dsh-web-upstream / deploy / patch-dsh-settings / patch-dsh-fs-fence | 是 |
| `docs/` | 拆分文档(配置/脚本/使用/运维/部署/排查/开发) | 是 |
| `examples/` | 局域网 / 回环两种组合 patch 示例 | 是 |
| `lib/`、`node_modules/`、`data/` | 构建产物、依赖、运行数据 | **否(.gitignore)** |

## 命令

- 构建:`./scripts/build.sh`(改 `src/` 后必须;产出 `lib/`)
- 测试:`./scripts/test.sh`(全量 105;过滤:`./scripts/test.sh -t <pattern>`)
- 启停:`./scripts/start.sh` / `./scripts/stop.sh`(写 `data/gateway.{log,pid}`)
- 一键部署(新机器):`./scripts/deploy.sh`(装依赖 → 构建 → 创建 profile → 写 patch → 启动;幂等)
- dsh 设置页补丁:`./scripts/patch-dsh-settings.sh`(dsh 升级后重跑;`--status`/`--revert`/`--restart`)
- dsh 文件系统围栏补丁:`./scripts/patch-dsh-fs-fence.sh`(dsh 升级后重跑;成员目录隔离的 dsh 侧半边)
- 依赖重建(检出换位后):`DSH_CHECKOUT=<检出> ./scripts/setup-deps.sh`

## 硬性契约(测试断言,改动必须同步 tests/)

- 命名:包名与插件名 `dhx-gateway`;Cookie 名 `dhxgw_session`(`GATEWAY_COOKIE_NAME`)。
- 数据根:默认 `<项目根>/data`,由模块自身 realpath 推导(`config.ts` 的 `packageRoot()`);**不得改回 dsh 安装内**,`stateRoot` 配置是唯一的覆盖入口。
- `users.json` 是 `STORE_VERSION = 1` 的原子写存储(经 dsh-atomic-write);改结构必须升版本并保持 fail-loud 校验,不做兼容读取。
- `secret.key` 是会话签名根密钥:**永不入库、永不写进日志或错误信息**。
- 上游进程只绑回环:`dshCommand` 由 supervisor 追加 `--host 127.0.0.1 --port 0 --no-open`;`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` 不下发子进程(BYOK);supervisor 注入 `DSH_HOST_FS_FENCE=<usersRoot>/<用户>`(文件系统围栏,dsh 检出补丁消费);网关以 setsid 独立进程组启动,stop.sh 按组整杀,不留孤儿上游。
- 保留路径 `/login` `/logout` `/invite/<token>` `/gw-admin` 由网关拦截,其余全部进回退席位代理;新增保留路径须同步 `docs/usage.md`。
- 401 自愈重试仅限无体 GET/HEAD —— 不要扩展到带体请求。

## 约定

- 脚本是 POSIX sh;新增脚本环境变量必须同步 [docs/scripts.md](docs/scripts.md) 的环境变量表。
- 文档单一事实源:配置字段在 [docs/configuration.md](docs/configuration.md),脚本在 [docs/scripts.md](docs/scripts.md),数据布局在 [docs/operations.md](docs/operations.md),排查项在 [docs/troubleshooting.md](docs/troubleshooting.md)。改行为必须同步对应文档;[README](README.md) 只保留概览、快速开始与文档地图。
- 行为变化 accompanying 测试:改 src/ 必须重跑 build + test;修 bug 必须带回归用例。
- dsh 检出是外部依赖(`link:`):不要把检出内的文件拷进本仓库,也不要修改检出。

## 提交

- `git add -A && git commit`;主题行中文一句话,正文列要点;`git push origin main`。
- 本机若遇 `Bad owner or permissions on /etc/ssh/ssh_config.d/...`,推送用 `GIT_SSH_COMMAND="ssh -F /dev/null" git push origin main`。
