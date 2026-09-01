# 已知限制与故障排查

> 覆盖:设计上不做的(已知限制)与常见症状的处理。
> 上游:[README](../README.md) · 相邻:[部署形态](deployment.md)(WSL/HTTPS) · [脚本一览](scripts.md)(启停)

## 已知限制

- 单网关进程串行管理所有上游;进程数上限受内存约束(每用户一个完整 `dsh web`)。
- 无账号级速率限制;信任模型是"内网同事",不是公网访客。
- 邀请链接仅显示一次,丢失只能作废重建。
- `publicOrigin` 只影响打印的链接;若实际访问地址与它不符,浏览器手动输入即可,鉴权不受影响。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 端口被占(`EADDRINUSE`) | 换 `webserver.port`;或先停掉占用进程(`ss -tlnp \| grep 8080`)。 |
| 局域网设备打不开 | 确认 `host: 0.0.0.0`;检查防火墙;WSL 见[部署形态](deployment.md);本机自测时留意环境变量代理(`http_proxy`)会截走请求,`curl --noproxy '*'` 验证。 |
| 登录后白屏/超时 | 上游启动超过 `startTimeoutMs`;源码运行方式调到 `60000`,并看网关日志中该用户的启动输出。 |
| 页面一直显示「连接中」 | dsh web 的流式 WebSocket(`/api/remote.mux` upgrade)没有打通:确认网关为修过该能力的版本(升级代理需 `webServer.registerUpgrade`,见 `src/upgrade.ts`);旧版本网关只代理普通 HTTP,upgrade 请求在 webserver 处查不到路由被直接断开,前端无限重连。 |
| 请求偶发 502/504 | 上游崩溃进入冷却重启;查 `<usersRoot>/<user>/home` 内的日志与网关日志。 |
| 启动不打印邀请 | 账号库已有用户(正常);或 `printBootstrapInvite: false`。 |
| 设置页报「settings are unavailable in this browser」(无法配置 API Key) | **dsh 上游的安全栅栏,非网关故障**:设置文档(含凭据)只允许从回环主机名(`localhost`/`127.*`)的页面管理,判定在浏览器内读页面主机名,与协议无关(HTTPS 也无效),网关无法干预。处理:需要配置凭据的同事用 SSH 隧道 `ssh -N -L 8080:127.0.0.1:8080 <server>` 后走 `http://127.0.0.1:8080` 配一次(Key 持久在该用户的 `usersRoot/<用户>/home`),日常使用照走局域网地址,不受影响。 |
| `dshCommand` 找不到可执行 | 该命令以**绝对路径**解析最稳(网关以用户工作区为 cwd 拉起子进程)。 |
| 上游报 `Upstream unavailable … exited before its ready URL line`(源码运行) | 上游在打印 ready 行前就退出了,典型原因:`dshCommand` 直接指向 `tsx <检出>/apps/cli/src/bin.ts` —— tsx 按**子进程 cwd**(用户工作区)向上查找 tsconfig,找到的 tsconfig 没有 `@deepseek-ai/*` 的 paths 映射,`@deepseek-ai/cordis` 解析到检出内 vendor 的预构建产物,其导出与源码不同步(报 `does not provide an export named …`),进程启动即崩。处理:改用 `['<项目根>/scripts/dsh-web-upstream.sh', 'web']`(内部先 cd 到检出根再启动);该脚本的启动输出经插件日志器落盘,若 `gateway.log` 看不到,可直接手动以同样参数与 `DSH_HOME=<usersRoot>/<用户>/home` 复现看 stderr。 |
| 启动即报 `profile "gateway" does not exist` | 两种可能:①**新机器部署漏了装入步骤** —— profile 是 dsh 侧运行态(`DSH_HOME/profiles/gateway`,含装入的依赖),不在 git 里。直接在项目里跑 `./scripts/deploy.sh` 一键完成(装依赖、构建、创建 profile、写 patch、启动);或手动 `cd <检出> && export DSH_HOME=<检出>/.dsh-home && pnpm dsh plugin --profile gateway add <项目绝对路径>` 创建,并写好 `cordis.patch.yml`,再跑 `start.sh`;②外层环境已导出 `DSH_HOME`(例如 dsh 桌面端)且其中没有该 profile —— 启动脚本会自动回退到检出内主目录,但若你把 profile 建在了别处,请让创建与启动使用同一个 `DSH_HOME`。 |
| 日志为空或滞后 | 网关 stdout 经管道时按块缓冲,属正常;账号与会话数据是独立的原子写,不受影响。 |
