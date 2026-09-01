# 配置参考

> 覆盖:`dhx-gateway` 插件的全部配置字段,以及组合内 webserver 的要点。
> 上游:[README](../README.md) · 相邻:[脚本一览](scripts.md)(环境变量) · [部署形态](deployment.md)(HTTPS 参数联动)

字段写在 profile 的 `cordis.patch.yml` 中插件行的 `config:` 下。全部字段在插件加载时校验并落实默认值,违规在启动即报错。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `dshCommand` | `string[]` | 必填 | 启动每个用户上游的命令与参数;网关会自动追加 `--host 127.0.0.1 --port 0 --no-open`,并以用户工作区为 cwd。正常安装用 `['dsh', 'web']`;从检出源码运行时**必须**用 `['<项目根>/scripts/dsh-web-upstream.sh', 'web']`(tsx 按 cwd 查找 tsconfig 应用 paths 映射,直接指到 `tsx bin.ts` 会在用户工作区 cwd 下解析到与源码不同步的 vendor 构建产物,上游启动即崩),见 [troubleshooting](troubleshooting.md)。 |
| `stateRoot` | `string` | `<项目根>/data` | 网关持久状态根目录(账号库、签名密钥、每用户数据)。**默认在项目自己的 data/ 目录下,不在 dsh 安装内**;支持 `~` 与绝对路径覆盖。 |
| `usersRoot` | `string` | `<stateRoot>/users` | 每用户数据根目录;`<usersRoot>/<用户名>/home` 是该用户上游的 `DSH_HOME`,`<usersRoot>/<用户名>/workspaces` 是其默认工作区。 |
| `sessionMaxAgeDays` | `number` | `30` | 网关会话 Cookie 有效期(天),上限 3650。 |
| `idleStopMinutes` | `number` | 不停止 | 上游空闲多少分钟后自动停止该用户的实例;省内存。省略则永不停止。 |
| `startTimeoutMs` | `number` | `30000` | 等待一个上游实例打印 ready 行的毫秒数;源码方式运行建议 `60000`。 |
| `secureCookies` | `boolean` | `false` | 会话 Cookie 是否加 `Secure` 标记;仅在 HTTPS 反向代理之后才开启。 |
| `printBootstrapInvite` | `boolean` | `true` | 账号库为空时启动是否打印引导邀请。 |
| `publicOrigin` | `string` | 未设时按监听端口打印回环 URL | 用于显示邀请链接的对外 origin,如 `https://dsh.example.com`。只影响展示,不影响鉴权。 |

## webserver 组合要点

`webserver` 插件与网关同组合装入,它的两个字段决定网关监听:

- `host`:`0.0.0.0`(局域网可达)或 `127.0.0.1`(仅本机)。
- `port`:网关端口;示例用 `8080`。
- `compression: none` **必须保留**——压缩会破坏 SSE 流式。

完整组合示例见 [examples/](../examples/)(局域网 / 回环两种),HTTPS 部署的字段联动见 [部署形态](deployment.md)。
