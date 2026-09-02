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
- **流式代理**:SSE 与 WebSocket 全透传(含 dsh web 的 `/api/remote.mux` 流式复用连接);Host 重写 + Origin/Referer 剥离,满足上游的信任栅栏,无需在上游配置 `trustedHosts`。
- **全中文界面**:登录、邀请、管理台、退出等网关自有页面均为中文。
- **按需启停**:首次登录拉起该用户的上游(ready 行协议探测就绪);可配置空闲自动停止以省内存。
- **成员自助退出**:访问 `/logout` 一键清除网关会话,不影响工作区实例与数据。
- **零侵入**:作为 cordis 插件运行,不修改 DeepSeek Harness 任何源码;组合通过 profile 的 patch 层声明。

## 环境要求

- Node.js `^22.19 || >=24`,pnpm ≥ 10。
- 一个已构建的 DeepSeek Harness 检出,与本项目互为兄弟目录(推荐 `~/git/deepseek-harness` 与 `~/git/dhx-gateway`;其他位置用 `DSH_CHECKOUT` 指定,见[开发](docs/development.md))。
- 多用户场景建议 2GB 以上空闲内存(每个活跃用户一个完整 `dsh web` 进程)。

## 快速开始

以下步骤假设:项目与 `deepseek-harness` 检出为兄弟目录(即 `~/git/dhx-gateway` 与 `~/git/deepseek-harness`),`dsh` 从检出以源码方式运行。

> **新机器/远程部署**可跳过第 2–4 步,直接运行 `./scripts/deploy.sh` 一键完成(装依赖、构建、创建 profile、写 patch 并启动;幂等,已有配置不会被覆盖),见[脚本一览](docs/scripts.md)。

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
        # 从检出源码运行时必须用包装脚本(绝对路径;直接指 tsx 会在用户工作区
        # cwd 下解析到过期的 vendor 产物,上游启动即崩);正式安装用 ['dsh', 'web']
        dshCommand: ['/home/you/git/dhx-gateway/scripts/dsh-web-upstream.sh', 'web']
        # 邀请链接展示地址自动推导(管理台按请求 Host、引导邀请按网卡枚举),
        # 无需配置;仅 HTTPS 反代/域名/容器映射等网关看不到真实地址的形态才设 publicOrigin
        startTimeoutMs: 60000
```

**4. 启动并认领管理员**

```sh
~/git/dhx-gateway/scripts/start.sh    # 前台运行则用: cd ~/git/deepseek-harness && pnpm dsh --profile gateway
```

首次启动(且账号库为空)会打印一次性引导邀请 —— 按本机网卡逐行列出全部候选地址(默认路由网卡排最前,回环兜底;同一 token 对所有地址有效):

```
dhx-gateway: bootstrap invite (single use): http://192.168.10.19:8080/invite/<token>
dhx-gateway: bootstrap invite (single use): http://172.17.0.1:8080/invite/<token>
dhx-gateway: bootstrap invite (single use): http://127.0.0.1:8080/invite/<token>
dhx-gateway: pick the address your members actually use, or set publicOrigin to override
```

用浏览器打开**同事实际访问地址**对应的那条链接,设置管理员用户名(小写字母/数字/短横线,≤32 字符)与密码(≥8 位)即完成初始化。此后管理员在 `/gw-admin` 为同事签发邀请(链接按管理员当前访问地址自动生成)。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | 插件全部配置字段与 webserver 组合要点 |
| [docs/scripts.md](docs/scripts.md) | 10 个脚本的用途、公共行为、环境变量 |
| [docs/usage.md](docs/usage.md) | 账号与邀请、保留路径、代理行为 |
| [docs/operations.md](docs/operations.md) | 数据布局、启停与日志、备份迁移、升级、重置 |
| [docs/deployment.md](docs/deployment.md) | HTTPS 反代、systemd 常驻、WSL 注意 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 已知限制与故障排查 |
| [docs/development.md](docs/development.md) | 目录结构、依赖形态、与 dsh 的关系 |
| [AGENTS.md](AGENTS.md) | 编码代理工作规则:契约、约定、提交规范 |
| [llms.txt](llms.txt) | 面向 agent 的机器可读文档索引 |

## 许可证

MIT(见 [LICENSE](LICENSE))。
