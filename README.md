# DHX Gateway(dhx-gateway)

**DHX Gateway**(DeepSeek Harness eXchange)—— DeepSeek Harness 多用户网关:把单用户的 DSH Web 变成一台多人共用的服务。一个网关进程对外提供统一的登录入口,为每个用户按需拉起完全独立的 `dsh web` 上游实例,并在中间做经过认证的流式代理。

本目录是一个**独立项目**:自带 `package.json`、构建与测试脚本,不依赖所在仓库的任何门禁;运行时以 cordis 插件形式装入 `dsh` 的 profile。

```
浏览器 ──登录/会话──▶ 网关(8080) ──按会话选路──▶ 用户A 的 dsh web(127.0.0.1:随机端口)
                  │                              用户B 的 dsh web(127.0.0.1:随机端口)
                  └──未登录一律重定向 /login         每人独立 DSH_HOME / 会话 / 工作区 / API Key
```

## 功能特性

- **内置账号**:用户名 + 密码(scrypt 加盐哈希持久化),不依赖任何外部身份系统。
- **邀请制开号**:管理员在 `/gw-admin` 签发一次性邀请链接;首次启动存在引导邀请用于认领管理员。
- **签名会话**:`dshgw_session` HttpOnly Cookie,HMAC-SHA256 签名,默认 30 天有效。
- **每用户完全隔离**:每个账号拥有独立的 `DSH_HOME`(配置、会话、凭据)与默认工作区;上游进程只绑定回环地址,外界无法绕过网关直连。
- **自带密钥(BYOK)**:网关不持有任何用户的 `DEEPSEEK_API_KEY`——它不会下发给子进程,每个用户在自己 GUI 的凭据设置里配置。
- **流式代理**:支持 SSE 流式响应;Host 重写 + Origin/Referer 剥离,满足上游的信任栅栏,无需在上游配置 `trustedHosts`。
- **按需启停**:首次登录拉起该用户的上游(ready 行协议探测就绪);可配置空闲自动停止以省内存。
- **零侵入**:作为 cordis 插件运行,不修改 DeepSeek Harness 任何源码;组合通过 profile 的 patch 层声明。

## 环境要求

- Node.js `^22.19 || >=24`,pnpm ≥ 10。
- 一个可运行的 DeepSeek Harness 检出(依赖其 `vendor/`、`packages/` 构建产物;见"开发"一节)。
- 多用户场景建议 2GB 以上空闲内存(每个活跃用户一个完整 `dsh web` 进程)。

## 快速开始

以下步骤假设:项目位于 `deepseek-harness` 检出根旁(当前布局),`dsh` 从检出以源码方式运行。

**1. 构建**

```sh
cd dhx-gateway
./scripts/build.sh        # 产出 lib/(构建工具来自检出根 node_modules)
```

**2. 装入 profile**(创建 `gateway` profile 并把本项目装为依赖)

```sh
cd <deepseek-harness 检出根>
export DSH_HOME="$PWD/.dsh-home"     # 部署主目录:账号、每用户数据、profile 都在这里
pnpm dsh plugin --profile gateway add "$PWD/dhx-gateway"
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
pnpm dsh --profile gateway
```

首次启动(且账号库为空)会打印一次性引导邀请,例如:

```
dhx-gateway: bootstrap invite (single use): http://192.168.10.19:8080/invite/<token>
```

用浏览器打开该链接设置管理员用户名(小写字母/数字/短横线,≤32 字符)与密码(≥8 位)即完成初始化。此后管理员在 `/gw-admin` 为同事签发邀请。

## 配置参考

`dhx-gateway` 插件的全部配置字段(`cordis.patch.yml` 中 `config:` 下):

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `dshCommand` | `string[]` | 必填 | 启动每个用户上游的命令与参数;网关会自动追加 `--host 127.0.0.1 --port 0 --no-open`。正常安装用 `['dsh', 'web']`;从检出源码运行时用 `['<检出>/node_modules/.bin/tsx', '<检出>/apps/cli/src/bin.ts', 'web']`。 |
| `stateRoot` | `string` | `<DSH_HOME>/dhx-gateway` | 网关持久状态根目录(账号库、密钥、会话撤销)。支持 `~` 展开。 |
| `usersRoot` | `string` | `<stateRoot>/users` | 每用户数据根目录;`<usersRoot>/<用户名>/home` 是该用户上游的 `DSH_HOME`,`<usersRoot>/<用户名>/workspaces` 是其默认工作区。 |
| `sessionMaxAgeDays` | `number` | `30` | 网关会话 Cookie 有效期(天),上限 3650。 |
| `idleStopMinutes` | `number` | 不停止 | 上游空闲多少分钟后自动停止该用户的实例;省内存。省略则永不停止。 |
| `startTimeoutMs` | `number` | `30000` | 等待一个上游实例打印 ready 行的毫秒数;源码方式运行建议 `60000`。 |
| `secureCookies` | `boolean` | `false` | 会话 Cookie 是否加 `Secure` 标记;仅在 HTTPS 反向代理之后才开启。 |
| `printBootstrapInvite` | `boolean` | `true` | 账号库为空时启动是否打印引导邀请。 |
| `publicOrigin` | `string` | 未设时按监听端口打印回环 URL | 用于显示邀请链接的对外 origin,如 `https://dsh.example.com`。只影响展示,不影响鉴权。 |

`webserver` 的 `host`/`port` 决定网关监听地址;`compression: none` 必须保留(SSE 兼容)。

## 使用指南

### 账号与邀请

- **引导邀请**:账号库为空时每次启动都会打印(同一密钥派生,token 在整个空库期间稳定),打开即建管理员,仅可用一次。
- **邀请同事**:管理员登录后访问 `/gw-admin` → 新建邀请。每条链接只显示一次、只能建一个账号、不设过期(删除即作废)。
- **停用账号**:`/gw-admin` 删除账号;其会话立即失效,上游进程被停止,数据保留在 `usersRoot`(可随时重建同名账号)。
- **密码**:存储为 scrypt(N=16384, r=8, p=1)加盐哈希;数据库文件 `stateRoot/users.json`。

### 保留路径

网关在上游之前拦截以下路径,其余路径全部代理到当前会话用户的上游:

| 路径 | 行为 |
| --- | --- |
| `/login` | 登录页与登录提交 |
| `/logout` | 注销并清除会话 |
| `/invite/<token>` | 邀请接受页(建号即登录) |
| `/gw-admin` | 网关管理台(仅管理员) |
| 其余所有路径 | 回退席位:代理到当前用户上游;未登录 303 → `/login` |

### 代理行为

- 每个网关会话在服务端持有对应该用户上游的 Cookie jar,浏览器只见到 `dshgw_session`。
- 请求到达上游时 Host 改写为上游地址、`Origin`/`Referer` 剥离——上游按同源信任处理,无需 `trustedHosts`。
- SSE/长连接透传,不缓冲;仅无体的 GET/HEAD 在 401 时自动重试一次(会话过期自愈)。

## 运维

### 数据布局(默认)

```
<DSH_HOME>/
├── profiles/gateway/          # 组合定义(package.json + cordis.patch.yml + 装入的依赖)
└── dhx-gateway/              # stateRoot
    ├── users.json             # 账号库(scrypt 哈希 + 邀请码)
    ├── secret                 # 会话签名密钥(首次启动生成;备份它 = 不失效所有会话)
    └── users/<name>/
        ├── home/              # 该用户的 DSH_HOME(profiles/web、storages、凭据)
        └── workspaces/        # 该用户上游的默认工作区
```

### 启停与日志

本仓库检出内的部署附带了脚本(位于 `.dsh-home/`):

```sh
.dsh-home/start-gateway.sh   # 后台启动,日志追加到 .dsh-home/gateway.log,PID 写入 gateway.pid
.dsh-home/stop-gateway.sh    # 按 PID 停止
```

### 备份与迁移

- 备份 `stateRoot` 即备份全部账号与邀请;每用户数据在 `usersRoot`。
- 迁移机器:拷贝 `<DSH_HOME>`,新机上保持 `DSH_HOME` 指向它即可;密钥随迁,旧会话不失效。

### 升级插件

```sh
./scripts/build.sh           # 重新构建 lib/
# 重启网关进程(用户上游会在下次访问时自动重拉)
```

### 重置账号

忘记管理员密码:停止网关 → 备份后删除 `<stateRoot>/users.json` → 启动 → 打印新的引导邀请重新建号。每用户数据不受影响。

## 部署形态

### HTTPS 反向代理(推荐对外)

明文 HTTP 只适合可信内网。对外服务请加 TLS 终结层,并开启 `secureCookies: true`、把 `publicOrigin` 设为对外 https origin。Caddy 示例:

```
dsh.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```yaml
# cordis.patch.yml 中同步修改
        secureCookies: true
        publicOrigin: 'https://dsh.example.com'
```

### systemd 常驻(Linux)

```ini
[Unit]
Description=DSH Multi-User Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/wang/git/deepseek-harness
Environment=DSH_HOME=/home/wang/git/deepseek-harness/.dsh-home
ExecStart=/usr/bin/node --import tsx/esm apps/cli/src/bin.ts --profile gateway
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### WSL 注意

WSL2 NAT 网络模式下,局域网设备可能无法直达 WSL 内的端口:需在 Windows 侧 `netsh interface portproxy` 转发,或启用镜像网络模式(`.wslconfig` 中 `networkingMode=mirrored`)。网关绑定 `0.0.0.0` 后,先在 Windows 本机验证 `http://<WSL IP>:8080`。

## 已知限制

- 单网关进程串行管理所有上游;进程数上限受内存约束(每用户一个完整 `dsh web`)。
- 无账号级速率限制;信任模型是"内网同事",不是公网访客。
- 邀请链接仅显示一次,丢失只能作废重建。
- `publicOrigin` 只影响打印的链接;若实际访问地址与它不符,浏览器手动输入即可,鉴权不受影响。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 端口被占(`EADDRINUSE`) | 换 `webserver.port`;或先停掉占用进程(`ss -tlnp | grep 8080`)。 |
| 局域网设备打不开 | 确认 `host: 0.0.0.0`;检查防火墙;WSL 见上文;本机自测时留意环境变量代理(`http_proxy`)会截走请求,`curl --noproxy '*'` 验证。 |
| 登录后白屏/超时 | 上游启动超过 `startTimeoutMs`;源码运行方式调到 `60000`,并看网关日志中该用户的启动输出。 |
| 请求偶发 502/504 | 上游崩溃进入冷却重启;查 `<usersRoot>/<user>/home` 内的日志与网关日志。 |
| 启动不打印邀请 | 账号库已有用户(正常);或 `printBootstrapInvite: false`。 |
| `dshCommand` 找不到可执行 | 该命令以**绝对路径**解析最稳(网关以用户工作区为 cwd 拉起子进程)。 |

## 开发

```
dhx-gateway/
├── src/               # 插件源码(config/index/invariant/pages/password/proxy/routes/
│                      #   secret/session-cookie/store/supervisor/upstream-jar)
├── tests/             # 13 个测试文件 + fixtures/fake-dsh-web.mjs(95 个用例)
├── examples/          # 局域网 / 回环两种组合 patch 示例
├── scripts/           # build.sh / test.sh / setup-deps.sh
├── lib/               # 构建产物(git 忽略)
└── package.json       # 依赖以 link: 指向检出内的包(见下)
```

- **构建**:`./scripts/build.sh`(tsc;工具链取自检出根)。**测试**:`./scripts/test.sh`(vitest,95/95)。
- **依赖形态**:运行时依赖(4 个)与构建/测试期类型依赖(2 个)都以 `link:` 指向 `deepseek-harness` 检出内的 `vendor/`、`packages/`。项目位于检出内时无需网络即可构建;若把项目**迁移到检出外**,运行:

  ```sh
  DSH_CHECKOUT=/path/to/deepseek-harness ./scripts/setup-deps.sh
  ```

  它会把全部 link 目标改写为新检出路径并安装 `node_modules`。
- **与 monorepo 包的关系**:`deepseek-harness/packages/host/multi-user-gateway` 是受仓库门禁(100% 覆盖率、双语 README、config-catalog 等)约束的实现源头,npm 名 `@deepseek-ai/dsh-host-multi-user-gateway`;本目录是面向部署与文档的独立项目 **DHX Gateway**,npm 名 `dhx-gateway`,可直接被 profile 装入。代码演进请先落 monorepo(吃门禁),再同步到本目录重新构建;两侧源码目前同源,仅命名不同。

## 许可证

MIT(见 [LICENSE](LICENSE))。
