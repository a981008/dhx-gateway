# DHX Gateway(dhx-gateway)

**DHX Gateway**(DeepSeek Harness eXchange)是一个**独立的开源项目**,为 dsh(DeepSeek Harness)提供多用户网关插件:把单用户的 DSH Web 变成一台多人共用的服务。

- **GitHub**:https://github.com/a981008/dhx-gateway
- **形态**:`dsh`(DeepSeek Harness)的 cordis 插件 —— npm 包 `dhx-gateway`,通过 dsh 的 profile patch 装入,不修改 dsh 任何源码
- **工作方式**:一个网关进程对外提供统一的登录入口,为每个用户按需拉起完全独立的 `dsh web` 上游实例,并在中间做经过认证的流式代理

```
浏览器 ──登录/会话──▶ 网关(8080) ──按会话选路──▶ 用户A 的 dsh web(127.0.0.1:随机端口)
                  │                              用户B 的 dsh web(127.0.0.1:随机端口)
                  └──未登录一律重定向 /login         每人独立 DSH_HOME / 会话 / 工作区 / API Key
```

## 功能特性

- **内置账号**:用户名 + 密码(scrypt 加盐哈希持久化),不依赖任何外部身份系统。
- **邀请制开号**:管理员在 `/gw-admin` 签发一次性邀请链接;首次启动存在引导邀请用于认领管理员。
- **签名会话**:`dhxgw_session` HttpOnly Cookie,HMAC-SHA256 签名(无服务端会话表,重启不失效),默认 30 天有效。
- **每用户完全隔离**:每个账号拥有独立的 `DSH_HOME`(配置、会话、凭据)与默认工作区;上游进程只绑定回环地址,外界无法绕过网关直连。
- **自带密钥(BYOK)**:网关不持有任何用户的 `DEEPSEEK_API_KEY`——它不会下发给子进程,每个用户在自己 GUI 的凭据设置里配置。
- **流式代理**:支持 SSE 流式响应;Host 重写 + Origin/Referer 剥离,满足上游的信任栅栏,无需在上游配置 `trustedHosts`。
- **按需启停**:首次登录拉起该用户的上游(ready 行协议探测就绪);可配置空闲自动停止以省内存。
- **零侵入**:作为 cordis 插件运行,不修改 DeepSeek Harness 任何源码;组合通过 profile 的 patch 层声明。

## 环境要求

- Node.js `^22.19 || >=24`,pnpm ≥ 10。
- 一个已构建的 DeepSeek Harness 检出,与本项目互为兄弟目录(推荐 `~/git/deepseek-harness` 与 `~/git/dhx-gateway`;其他位置用 `DSH_CHECKOUT` 指定,见[开发](docs/development.md))。
- 多用户场景建议 2GB 以上空闲内存(每个活跃用户一个完整 `dsh web` 进程)。

## 快速开始

以下步骤假设:项目与 `deepseek-harness` 检出为兄弟目录(即 `~/git/dhx-gateway` 与 `~/git/deepseek-harness`),`dsh` 从检出以源码方式运行。

**1. 构建**

```sh
cd ~/git/dhx-gateway
./scripts/build.sh        # 产出 lib/(优先用项目自身工具链,未安装时回退检出)
```

**2. 装入 profile**(创建 `gateway` profile 并把本项目装为依赖)

```sh
cd ~/git/deepseek-harness
export DSH_HOME="$PWD/.dsh-home"     # dsh 主目录:profile(组合定义)在这里;插件数据默认在项目 data/ 下
pnpm dsh plugin --profile gateway add ~/git/dhx-gateway
```

> 若 pnpm 因全局 store 所在分区只读而报 `ERR_SQLITE_ERROR`:在 `<DSH_HOME>/profiles/gateway/.npmrc` 写入
> `store-dir=<可写路径>/pnpm-store` 后重试,或直接 `cd <DSH_HOME>/profiles/gateway && pnpm add <项目绝对路径> --store-dir <可写路径>/pnpm-store --ignore-scripts`。
> 非 bundle 包装入时会有一条"未激活任何 layer"的告警——正常,组合行由下一步的 patch 显式声明。

**3. 写组合 patch** — `<DSH_HOME>/profiles/gateway/cordis.patch.yml`(示例见 [`examples/`](examples/)):

```yaml
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 0.0.0.0          # 局域网可达;仅本机用 127.0.0.1
        port: 8080
        compression: none      # 压缩会破坏 SSE 流式
    - id: dhx-gateway
      name: 'dhx-gateway'
      config:
        dshCommand: ['dsh', 'web']
        publicOrigin: 'http://192.168.10.19:8080'   # 局域网部署才需要;用于打印邀请链接
        startTimeoutMs: 60000
```

**4. 启动并认领管理员**

```sh
~/git/dhx-gateway/scripts/start.sh    # 前台运行则用: cd ~/git/deepseek-harness && pnpm dsh --profile gateway
```

首次启动(且账号库为空)会打印一次性引导邀请,例如:

```
dhx-gateway: bootstrap invite (single use): http://192.168.10.19:8080/invite/<token>
```

用浏览器打开该链接设置管理员用户名(小写字母/数字/短横线,≤32 字符)与密码(≥8 位)即完成初始化。此后管理员在 `/gw-admin` 为同事签发邀请。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | 插件全部配置字段与 webserver 组合要点 |
| [docs/scripts.md](docs/scripts.md) | 6 个脚本的用途、公共行为、环境变量 |
| [docs/usage.md](docs/usage.md) | 账号与邀请、保留路径、代理行为 |
| [docs/operations.md](docs/operations.md) | 数据布局、启停与日志、备份迁移、升级、重置 |
| [docs/deployment.md](docs/deployment.md) | HTTPS 反代、systemd 常驻、WSL 注意 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 已知限制与故障排查 |
| [docs/development.md](docs/development.md) | 目录结构、依赖形态、与 dsh 的关系 |
| [AGENTS.md](AGENTS.md) | 编码代理工作规则:契约、约定、提交规范 |
| [llms.txt](llms.txt) | 面向 agent 的机器可读文档索引 |

## 许可证

MIT(见 [LICENSE](LICENSE))。
