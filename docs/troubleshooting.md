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
| 请求偶发 502/504 | 上游崩溃进入冷却重启;查 `<usersRoot>/<user>/home` 内的日志与网关日志。 |
| 启动不打印邀请 | 账号库已有用户(正常);或 `printBootstrapInvite: false`。 |
| `dshCommand` 找不到可执行 | 该命令以**绝对路径**解析最稳(网关以用户工作区为 cwd 拉起子进程)。 |
| 启动即报 `profile "gateway" does not exist` | 外层环境已导出 `DSH_HOME`(例如 dsh 桌面端),启动脚本/服务沿用了它 —— 显式指定 `DSH_HOME=<检出>/.dsh-home` 或先 `unset DSH_HOME`。 |
| 日志为空或滞后 | 网关 stdout 经管道时按块缓冲,属正常;账号与会话数据是独立的原子写,不受影响。 |
