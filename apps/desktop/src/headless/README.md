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

## 从源码验证

```bash
pnpm install --frozen-lockfile
pnpm --filter @deva/desktop build:headless
node --test apps/desktop/test/headless-chat.test.mjs
```

该测试通过本地 HTTP/SSE 模拟三种模型协议，逐一检查请求地址、鉴权头、发送的历史、流式回复、停止和重启续聊，也覆盖会话整理、文本附件的字节边界与重启重放、协议结束前断线和不受支持的输出；无需生产密钥。运行已构建的 Linux 服务：沿用上面的部署变量，执行 `node apps/desktop/out/headless/server.mjs`。原生入口默认监听 `127.0.0.1`，可用 `DEVA_HOST` 配置，专用数据目录默认 `~/.deva-web`。
