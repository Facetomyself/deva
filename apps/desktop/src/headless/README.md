# Headless Web · 基础文字对话

在没有桌面的 Linux 主机上运行一个单所有者文字聊天服务。浏览器可新建会话、接收流式回复、停止生成并重开历史。使用桌面同源的样式、发送/停止控件和模型协议适配器。每个部署只启用一个模型。运行镜像只有 Node 22 和编译产物，无 Electron、X11、VNC 或手机中转。此入口不加载桌面 Agent、工具或扩展。

## 用 Compose 运行

以下命令在仓库根目录的 Bash 中执行。示例使用一个 OpenAI 兼容模型；地址含服务商要求的 `/v1` 前缀，模型名换成账号确实可用的 ID：

```bash
export DEVA_MODEL_BASE_URL=https://api.openai.com/v1
export DEVA_MODEL=gpt-4.1-mini
read -rsp '模型 API key: ' DEVA_MODEL_API_KEY; echo; export DEVA_MODEL_API_KEY
export DEVA_WEB_TOKEN="$(openssl rand -hex 32)"
docker compose up --build -d --wait
printf '浏览器登录令牌：%s\n' "$DEVA_WEB_TOKEN"
```

打开 **http://127.0.0.1:8787**，用上面的 **Web 令牌**登录（不是模型密钥）。点击「新建」，输入文字并发送；回复过程中可点「停止」。在另一台电脑使用时，可以先运行 `ssh -L 8787:127.0.0.1:8787 user@server`，再打开相同的本地地址。页面和服务无需第三方中转。

在同一套部署环境中运行 `docker compose up -d --force-recreate --wait`，重新登录，再点之前的会话继续聊。命名卷 `deva-data` 保留历史；`docker compose down` 保留卷，`down -v` 会删除它。普通服务进程重启会使旧登录失效。停止后保留已经生成的文字，刷新或重启不会自行重发上一条消息。

[查看真实浏览器截图：服务重启并重新登录后，完整回复与已停止的回复都保留在原会话中。](../../../../docs/headless-chat.png) 图中均为本地测试对话。

## 选择模型协议

`DEVA_MODEL_PROTOCOL` 是部署变量，网页没有协议切换按钮。未设置时沿用 `openai`；填写时必须是下表中的小写值。服务在启动时检查配置，不探测供应商，也不在出错后换协议重发。

| 值 | 协议 | `DEVA_MODEL_BASE_URL` 示例 | 请求路径（示例） |
| --- | --- | --- | --- |
| `openai`（默认） | OpenAI Chat Completions | `https://api.openai.com/v1` | `/v1/chat/completions` |
| `responses` | OpenAI Responses | `https://api.openai.com/v1` | `/v1/responses` |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | `/v1/messages` |

兼容网关可保留自己的路径前缀。Anthropic 基地址可带一个末尾 `/v1`；填写基地址，不要填到 `/messages` 或 `/responses` 请求端点。选择 `responses` 或 `anthropic` 时，同时把 `DEVA_MODEL`、基地址和模型密钥设为该供应商对应的值，然后用 `docker compose up -d --force-recreate --wait` 应用变更。

更改协议不需要迁移会话文件。仅打开或整理历史时不会联系模型；**下一次主动发送时，会把该会话的文字历史一并发给新配置的模型服务**。Responses 使用 `store: false`，续聊依赖本地历史而非远端响应 ID。两种新增协议都以自身的终止事件判断完成；上游中断时保留已经显示的部分文字，并提示中断。

## 手动发送文本附件

在一条已打开的会话里点「添加文件」，从**浏览器所在设备**选择一个非空的 UTF-8 `.txt` 或 `.md` 文件（每条消息最多一个，最大 **32 KiB**）。文件卡显示文件名、字节数和「尚未发送」。可以展开纯文本预览或移除；选择、预览、移除都在当前页完成，不上传草稿。切换会话、刷新页面或退出会丢弃未发送的附件。

点「发送」（或在输入框按原有的 Enter 发送键）才会把**文件名和完整文字**作为当前用户消息发给部署时配置的模型。可以只发送附件；此时默认会话名取文件名，网页不会把系统代填的问题显示成用户输入。已发送的文字保存在专用会话卷中，重启后可展开查看，不再读取原文件；以后主动续聊时，它会随文字历史再次发送，即使此时换了模型服务商。

Markdown、HTML 和链接都按字面文字预览，不会打开外部资源。这里没有上传暂存区，不接受服务器路径、URL、目录、图片或 PDF。已有纯文字会话无需迁移；如需回退到只接受单一文字块的旧版本，请使用升级前的卷备份。

## 整理会话

打开一条会话可点「重命名」；清空标题并保存会恢复首条用户消息生成的标题。改名只改显示名称，即使回复正在生成，完成时也会保留最新标题。点「归档」会将空闲会话移出当前列表；点侧栏「已归档」可查看原消息，再用「移回会话列表」恢复。归档和还原都保留消息和原有活动顺序，且不会请求模型。

如果另一个窗口已修改同一会话，旧窗口会提示冲突并保留标题草稿；先查看最新标题，再明确保存或取消，不会自动覆盖。归档的是原生会话文件里的标记，并非删除，因此仍占用会话名额。此版本可直接读取基础版创建的会话，读取本身不迁移文件。升级前请备份卷：若回退到仅识别旧格式的基础版，应恢复配套备份；旧版不会列出已写入新整理字段的会话。

## 配置与范围

- `DEVA_WEB_TOKEN` 是部署者保管的高熵登录令牌（32–128 个 base64url 字符）；`DEVA_MODEL_API_KEY` 只注入服务端，使用无密钥本地模型时留空。Compose 会把这些环境变量交给容器，Docker 管理员可读取；长期部署请用私有环境文件或部署平台管理，勿提交到 Git。浏览器登录 Cookie 为 HttpOnly、SameSite=Strict，默认 8 小时有效。
- 默认只发布到宿主 `127.0.0.1:8787`。`DEVA_PORT` 改端口，`DEVA_BIND` 改 Docker 发布地址。反代访问时设置 `DEVA_ORIGIN=https://deva.example.org` 为用户实际打开的源，反代保留其 Host、使用 TLS 并关闭流式响应缓冲。服务端校验 Host 和写请求 Origin，没有面向跨域应用的 API。`/healthz` 只检查服务存活，不请求模型。
- `DEVA_MODEL` 和 `DEVA_MODEL_BASE_URL` 由部署者指定；浏览器不能更换上游地址。远程模型使用 HTTPS。keyless 本地服务可用受信网络内的 HTTP 地址，例如同一 Docker 网络里的 `http://ollama:11434/v1`。容器里的 `127.0.0.1` 指容器自身。
- `DEVA_HOME` 对应容器内 `/data`，首次须为空且仅运行用户可访问。运行时持有单写者锁；使用此服务专用的卷，而非正在使用的桌面数据目录。只打开本入口创建的原生文字会话文件。每条提问至多 8 KiB，另可附一个至多 32 KiB 的文本文件；回复至多 64 KiB，每次等待最多 2 分钟。每个实例至多 64 个会话、2 个在途回复。每个会话至多 128 轮；256 KiB 历史预算包含实际发送的附件文字和外层标记，并为新回复预留空间。没有自动压缩、通用文件管理或命令执行。

## 离线校验项目资料快照

部署者可以在启动服务前检查一份 v1 快照。先在仓库根目录构建独立工具，再从标准输入传入原始 UTF-8 字节。下面是公开的固定示例（`printf` 保留结尾一个换行，摘要只对应这一份示例）：

```bash
pnpm --filter @deva/desktop build:snapshot-check
printf '%s\n' '{"version":1,"project":"发布手册","documents":[{"name":"入门.md","text":"首次使用：先阅读版本说明。\n"}]}' |
  node apps/desktop/out/snapshot-check/check.mjs --sha256 17abef945c4669dcd7d6162cd1dd65084490d4249b1b6c6b9b8bf477ba0879f5
```

成功输出 `{"ok":true,"version":1,"documents":1,"textBytes":40,"sourceBytes":125}`。实际使用时，把**审核时独立记录**的 64 位小写 SHA-256 传给 `--sha256`，由 shell 用 `< "$SNAPSHOT_FILE"` 把待核对文件接到标准输入；直接用待核对文件当场算出的摘要只能自检格式，不能证明它是先前审核的版本。格式、摘要、输入或限额有误时退出码为 `1`，参数用法有误为 `2`；均不输出文档名或正文。超过 2 MiB 的管道输入在收到超额字节时即失败，无需等发送端关闭。

该工具不读取项目目录、登录令牌或环境变量中的摘要，也不连接模型、发布快照或授予访问权限。它独立于 Web 镜像构建。校验通过后，仍须由部署者执行下面的步骤，网页才能查看资料。

## 发布、查看和撤销只读项目资料（可选）

默认启动方式没有「项目资料」入口，也没有宿主文件挂载。要发布，先在**仓库、构建上下文和聊天卷以外**的部署者专用目录准备一份 v1 JSON 快照，逐条审核文件名和正文，并独立保存其原始字节的 SHA-256。只发布一份普通、单硬链接文件，不发布目录、符号链接或其他系统文件。容器以 UID 1000 读取这一个文件；准备权限时兼顾容器可读、宿主上其他用户不可遍历其专用目录。首次使用前构建上面的离线工具。

在仓库根目录执行，沿用基础版的模型、登录令牌和 Compose 项目名。下面两个变量来自部署者，而非聊天请求：

```bash
export DEVA_PROJECT_DOCS_FILE=/absolute/private/staging/reviewed.json
export DEVA_PROJECT_DOCS_SHA256="${REVIEWED_SHA256:?设置先前独立记下的 64 位小写摘要}"
node apps/desktop/out/snapshot-check/check.mjs --sha256 "$DEVA_PROJECT_DOCS_SHA256" < "$DEVA_PROJECT_DOCS_FILE" &&
  docker compose -f compose.yaml -f compose.project-docs.yaml up --build -d --force-recreate --wait
```

[可选 Compose 配置](../../../../compose.project-docs.yaml)只挂载该文件。服务只接受固定位置的独立只读文件挂载，核对 Linux 内核挂载标识、实际读取字节、摘要和快照格式；给一个普通文件改成 `0444` 并不满足条件。显式要求启用但验证失败会退出，不会进入健康状态，也不会自动降级去读取源目录。它需要可读取的真实 procfs 及每个文件描述符的挂载标识。默认关闭时不要求这些资料验证条件。

重新登录，点击「项目资料」才会读取清单，点击一行才读取该份正文。网页按纯文字显示 Markdown/HTML，打开资料不自动建立附件、不请求模型，也不把内容写入聊天卷。不同有效登录共享同一份发布物。关闭、退出、标签页隐藏或在其他同源标签页切换登录会清掉当前预览；这不是对已交付副本的远程擦除。反向代理需保留 Host，禁止缓存 `/api/project-docs` 及其子路径，并隐藏这些请求的文档 ID。

**撤销**：保留同一个 Compose 项目和聊天卷，先停掉旧服务（包括其他仍可访问的副本）并确认已退出，再只用基础配置重建。无需删除源文件或数据卷：

```bash
docker compose -f compose.yaml -f compose.project-docs.yaml stop deva &&
  (unset DEVA_PROJECT_DOCS_FILE DEVA_PROJECT_DOCS_SHA256; docker compose -f compose.yaml up -d --force-recreate --wait)
```

换版亦先停旧服务，用新文件、新的已审核摘要重新发布。仅替换或删除宿主原文件不会改变正在运行的快照。重新登录后旧文档 ID 失效，关闭资料时原有聊天仍可续聊。更多授权边界与验收条件见[只读资料设计](./project-docs-design.md)。

## 原生 amd64 Docker 成品验收

这是验收已提交版本的命令，不是日常部署命令。在**原生 x86-64 Linux** 上检出要验证的提交，使用 Node 22 或更新版本、Git、可访问的本地 Docker Engine 和 Compose v2+。无需安装项目依赖、提供模型密钥或复用正在运行的 Deva 实例。

```bash
# 只读检查架构、本地引擎和 Compose。成功也不代表容器已经运行。
node apps/desktop/test/verify-native-compose.mjs --preflight
# 实际构建和启动三次，清理完成后向标准输出写一条 JSON 回执。
node apps/desktop/test/verify-native-compose.mjs
```

[验收程序](../../test/verify-native-compose.mjs)从 Git 提交对象导出构建所需文件，使用一次性项目名、独立数据卷和动态宿主回环端口。它不会使用工作目录的 `.env`、未提交的文件、原有服务令牌或外部模型。首次构建仍需能获取基础镜像与锁定的依赖。不同 Compose 版本会省略不同的布尔默认值；程序在启动前用当前 CLI 对照渲染 `create_host_path` 的两个取值，只有原始的禁止自动创建配置用于实际运行。运行顺序是：

1. 基础实例用 Responses 协议完成含附件的第一轮；第二轮模型夹具只发一段文字，保持连接。在用户接口确认这段文字后发出 Stop，验证真实上游 TCP 连接在夹具主动结束前断开，并保存部分回复。
2. 用同一镜像和数据卷重建，改用 Anthropic 协议并授权一份只读快照；旧登录须失效，新登录可打开合成文档。模型实际收到的续聊历史须含原附件和刚刚停止的文字。
3. 停止已授权实例，撤下挂载，再用基础配置重建。旧文档 ID 返回 `404`；在原会话上用默认的 OpenAI Chat Completions 协议再发一条消息，须收到实际回复。三次启动均须从宿主发布的回环端口验证健康和登录，且容器 ID 各异、镜像 ID 一致、使用原命名卷。

**通过标准是退出码为 `0` 且回执为 `kind: deva-native-compose-v1`、`status: passed` 和 `cleanup: verified`。** 回执记录实际检出的 Git 提交、镜像内容 ID、三个容器 ID 与引擎版本，不含令牌、Cookie、文档 ID 或正文。程序只清理本次已核对归属的容器、网络、卷、镜像标签和暂存目录，不清空共享构建缓存。失败会在标准错误报告阶段与原因；预检、ARM64 运行、模拟输入测试、仅解析 Compose 配置都不是成品回执。CI 使用同一命令，只上传成功回执。

## 从源码验证

```bash
pnpm install --frozen-lockfile
pnpm --filter @deva/desktop build:headless
node --test apps/desktop/test/headless-chat.test.mjs
```

该测试通过本地 HTTP/SSE 模拟三种模型协议，逐一检查请求地址、鉴权头、发送的历史、流式回复、停止和重启续聊，也覆盖会话整理、文本附件的字节边界与重启重放、协议结束前断线和不受支持的输出；无需生产密钥。运行已构建的 Linux 服务：沿用上面的部署变量，执行 `node apps/desktop/out/headless/server.mjs`。原生入口默认监听 `127.0.0.1`，可用 `DEVA_HOST` 配置，专用数据目录默认 `~/.deva-web`。
