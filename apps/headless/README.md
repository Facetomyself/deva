# Deva 无桌面 Web 工作台（开发版）

当前可在 Linux 服务器独立启动：在浏览器认领实例、登录、打开**原桌面版的模型设置页**，配置服务商、密钥和自定义请求头，向真实端点拉取模型，刷新或重启后继续使用设置。该页面不是手机版或中转。完整桌面工作台的前端也从同一套 React 源码构建；目前尚未接通对话、工作区、任务及内置浏览器接管，勿把设置页当作完整版。

## Docker Compose（linux/amd64）

在本分支的仓库根目录执行：

```sh
docker compose up -d --build
docker compose ps
docker compose exec workbench node /opt/deva/apps/headless/src/cli.mjs claim
```

最后一条需要交互终端，只在调用者的终端显示 10 分钟有效的一次性链接。用浏览器打开，在页面为实例设置至少 12 个字符的口令。其后直接访问 `http://127.0.0.1:18787/` 登录。普通远端 SSH 部署可先将服务器 `127.0.0.1:18787` 转发到自己机器的同一回环端口；Compose 始终只发布宿主回环端口。服务器只有独立 Compose v2 时，命令前缀用 `docker-compose`。缺少 Buildx 的旧 Docker 可先以 `docker build -t deva-workbench:dev .` 原生构建，再 `docker-compose up -d --no-build`；无需改变 Docker 守护进程设置。

- HTTPS 反代：设置 `DEVA_PUBLIC_URL=https://你的域名` 并重建容器。反代须保留公共 `Host`，应用忽略 `X-Forwarded-Host`；认证 Cookie 在 HTTPS 下为 `Secure`、`HttpOnly`、`SameSite=Strict`。变更宿主回环端口可用 `DEVA_PUBLISHED_PORT`。
- 通常可在桌面设置页直接添加公网 HTTPS 模型。要连接内网、回环或明文 HTTP 模型，部署者须在 `DEVA_PROVIDER_ORIGINS` 明确列出允许的**精确 origin**，多个以逗号分隔。容器中的 `localhost` 只代表本容器；本机服务应通过设计好的私有网络连接，而非向公网发布。服务按持久化配置匹配地址和凭据，固定解析结果，不带工作台 Cookie，不随重定向发送鉴权头。
- 模型自定义请求头的值与 API key 存入加密密库。设置回读只显示保存状态/占位值；修改端点后要为新端点重新录入凭据。并发编辑发生冲突时刷新设置，而不是覆盖另一标签页的配置。当前页面是设置入口，选择/启用供模型运行使用的最终聊天面板正在接入。
- `GET /livez` 检查进程；`/readyz` 和 `/healthz` 检查已实现服务和构建产物是否就绪，不证明模型在线或所有桌面能力已经移植。
- `data` 卷保存配置、账号验证信息和密文，`keys` 卷保存独立主密钥。停服务后一并备份，妥善分开保管；回滚镜像不应删除卷。启动时已有密库缺主密钥、密钥错误或数据损坏会报错，不会重置账户。不要让桌面和服务器同时写同一数据目录；迁移桌面配置先制备独立副本，默认不会静默改写桌面明文自定义头或解密桌面系统密钥。普通 `docker compose down` 保留这两个卷。

### 已有内建 bridge、缺少端口发布 NAT 的主机

默认 Compose 会新建项目网络并发布一个回环端口。如果主机现有 Docker `bridge` 可以使用，但新建 bridge/端口发布失败，可显式采用私有 bridge 模式。它不修改防火墙，不创建新的 Docker bridge，**宿主不发布应用端口**。仅在信任该内建 bridge 上其他工作负载时使用；工作台认证仍开启。

```sh
docker build -t deva-workbench:dev .
docker compose -f compose.yaml -f compose.private-bridge.yaml up -d --no-build
docker compose -f compose.yaml -f compose.private-bridge.yaml exec workbench node /opt/deva/apps/headless/src/cli.mjs claim
cid=$(docker compose -f compose.yaml -f compose.private-bridge.yaml ps -q workbench)
docker inspect -f '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' "$cid"
```

从管理员电脑将本地回环 `18787` 转发到上一步得到的容器地址：`ssh -N -L 127.0.0.1:18787:<容器IP>:8787 <服务器SSH地址>`，然后访问认领链接。容器重建后重新读取 IP。Unix 控制通道始终留在容器内。

## 源码验证

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm workbench:build
pnpm workbench:check
pnpm headless:test
```

`node scripts/workbench/e2e-browser.mjs` 用真实、非 root 的沙箱 Chrome 与匹配的 ChromeDriver 检查认领、模型设置、拉取/添加、刷新和登出。它只连接本地测试工作台与测试模型；浏览器或沙箱不可用时测试失败，不计作通过。应用的服务端内置浏览器 worker 是另一个能力，与用户浏览器打开 Web 页面是两件事。

裸机需要 Node 22、Linux `/usr/bin/flock`、`/proc/self/fd` 和支持文件锁/目录 fsync 的本地文件系统。`node apps/headless/src/cli.mjs --help` 可查看 `init-key`、`serve`、`claim`、`status` 等参数。一次性凭据与登录口令不要写入源码、镜像或日志。完整功能进度见[能力清单](../../docs/development/web-workbench/parity-manifest.json)。
