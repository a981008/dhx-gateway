# 开发

> 覆盖:目录结构、构建/测试、依赖形态、与 dsh 的关系。
> 上游:[README](../README.md) · 相邻:[脚本一览](scripts.md) · 改码前必读 [AGENTS.md](../AGENTS.md)

## 目录结构

```
dhx-gateway/
├── src/               # 插件源码(config/index/invariant/origin/pages/password/proxy/
│                      #   routes/secret/session-cookie/store/supervisor/upgrade/upstream-jar)
├── tests/             # 15 个测试文件 + fixtures/fake-dsh-web.mjs(105 个用例)
├── docs/              # 拆分文档(配置/脚本/使用/运维/部署/排查)
├── examples/          # 局域网 / 回环两种组合 patch 示例
├── scripts/           # build.sh / test.sh / setup-deps.sh / start.sh / stop.sh /
│                      #   dsh-checkout.sh / dsh-web-upstream.sh(上游启动包装)
├── lib/               # 构建产物(git 忽略)
├── data/              # 运行数据(git 忽略;账号库、密钥、每用户数据)
└── package.json       # 依赖以 link: 指向检出内的包(见下)
```

## 构建 / 测试

- `./scripts/build.sh` 与 `./scripts/test.sh`(105/105),细节见[脚本一览](scripts.md)。

## 依赖形态

运行时依赖(4 个)与构建/测试期类型依赖(3 个)都以 `link:` 指向 `deepseek-harness` 检出内的 `vendor/`、`packages/`,目标写成**相对路径**(`link:../deepseek-harness/...`),package.json 可直接提交。标准布局(兄弟目录)下克隆后 `pnpm install` + `./scripts/build.sh` 即可;检出不在 `../deepseek-harness` 时运行一次 `DSH_CHECKOUT=<检出路径> ./scripts/setup-deps.sh` 重新绑定。

## 与 dsh 的关系

本项目是 **dsh(DeepSeek Harness)的插件**,以独立仓库演进(本仓库为主)。运行时通过 dsh 的扩展点接入:cordis 插件协议、webserver 路由注册、profile patch 组合;构建/测试期以 `link:` 使用 dsh 检出内的 `vendor/`、`packages/` 产物。源码历史上与 harness monorepo 内的 `packages/host/multi-user-gateway`(npm 名 `@deepseek-ai/dsh-host-multi-user-gateway`)同源,此后以本仓库为准独立演进。
