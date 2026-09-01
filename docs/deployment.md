# 部署形态

> 覆盖:HTTPS 反向代理、systemd 常驻、WSL 网络注意。
> 上游:[README](../README.md) · 相邻:[配置参考](configuration.md)(secureCookies/publicOrigin/stateRoot) · [已知限制与故障排查](troubleshooting.md)

## HTTPS 反向代理(推荐对外)

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

## systemd 常驻(Linux)

```ini
[Unit]
Description=DHX Gateway (dsh multi-user gateway plugin)
After=network.target

[Service]
Type=simple
# 检出根(dsh 源码启动的运行目录)
WorkingDirectory=/home/wang/git/deepseek-harness
# dsh 主目录(profiles 所在);不设则用 invoking 用户的默认主目录
Environment=DSH_HOME=/home/wang/git/deepseek-harness/.dsh-home
ExecStart=/usr/bin/node --import tsx/esm apps/cli/src/bin.ts --profile gateway
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

插件数据默认写在项目根 `data/`(与 systemd 无关);要用其他位置,在 patch 里设 `stateRoot`,或加一行 `Environment=DSH_DATA=/srv/dhx/data` 并让启停脚本使用同一目录。

## WSL 注意

WSL2 NAT 网络模式下,局域网设备可能无法直达 WSL 内的端口:需在 Windows 侧 `netsh interface portproxy` 转发,或启用镜像网络模式(`.wslconfig` 中 `networkingMode=mirrored`)。网关绑定 `0.0.0.0` 后,先在 Windows 本机验证 `http://<WSL IP>:8080`。
