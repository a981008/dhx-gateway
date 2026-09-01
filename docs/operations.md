# 运维

> 覆盖:数据布局、启停与日志、备份迁移、升级、重置账号。
> 上游:[README](../README.md) · 相邻:[脚本一览](scripts.md)(启停脚本与环境变量) · [配置参考](configuration.md)(stateRoot/usersRoot 字段)

## 数据布局(默认)

插件生成的数据**全部归项目自己所有**,默认在项目根的 `data/` 下;dsh 安装内只有组合定义(profile):

```
dhx-gateway/                       # 本项目
└── data/                          # stateRoot(插件数据根;DSH_DATA 可改到任意位置)
    ├── gateway.log                # 运行日志(启停脚本写入)
    ├── gateway.pid                # 运行 PID(启停脚本写入)
    ├── users.json                 # 账号库(scrypt 哈希 + 邀请码)
    ├── secret.key                 # 会话签名密钥(首次启动生成;备份它 = 不失效所有会话)
    └── users/<name>/
        ├── home/                  # 该用户的 DSH_HOME(profiles/web、storages、凭据)
        └── workspaces/            # 该用户上游的默认工作区

<DSH_HOME>/                        # dsh 安装侧(不是插件数据)
└── profiles/gateway/              # 组合定义(package.json + cordis.patch.yml + 装入的依赖)
```

把 `stateRoot`(patch 配置)或 `DSH_DATA`(启停脚本)指向任意可写路径,即可把数据放到项目之外。

## 启停与日志

```sh
scripts/start.sh   # 后台守护启动;已在运行则提示后原样退出
scripts/stop.sh    # SIGTERM 优雅退出(最多 5 秒),超时 SIGKILL
```

日志:`<DSH_DATA>/gateway.log`(追加);PID:`<DSH_DATA>/gateway.pid`。参数与环境变量见[脚本一览](scripts.md)。

```sh
# 自定义示例:数据目录放项目外 + 其他 profile
DSH_DATA=/srv/dhx/data DSH_PROFILE=gateway scripts/start.sh
```

## 备份与迁移

- 备份 `data/` 目录即备份全部账号、邀请、密钥与每用户数据。
- 迁移机器:整个项目目录(含 `data/`)拷走即可 —— 密钥随迁,旧会话不失效;数据与 dsh 安装互相独立。

## 升级插件

```sh
git pull                      # 或同步代码后
./scripts/build.sh            # 重新构建 lib/
scripts/stop.sh && scripts/start.sh
# 用户上游会在下次访问时自动重拉
```

## 重置账号

忘记管理员密码:停止网关 → 备份后删除 `<stateRoot>/users.json` → 启动 → 打印新的引导邀请重新建号。每用户数据不受影响。
