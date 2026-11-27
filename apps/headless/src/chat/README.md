# 通用文本回合

登录后的 Web 工作台在当前阶段支持通用文本；模型由服务端已保存、已启用的服务商和模型引用选定。服务使用桌面同源的会话文件、协议适配器和单步流处理。它不是完整 Agent 工具循环：客户端不能指定模型地址、系统提示、密钥或工具；模型偶发返回的工具请求不会执行。

| 同源地址 | 行为 |
|---|---|
| `GET /api/v1/chats` | 当前所有者的会话列表，含兼容性与可写状态。|
| `POST /api/v1/chats` | `{}` 创建通用会话；`{sessionId}` 提供规范 UUID 或受限桌面 `sess_…` ID；可另给 `personaId` 绑定已启用的服务器角色并定格首选模型。客户端只传角色和项目 ID。新建时省略 `workspaceId` 可继承角色已确认的项目，显式 `null` 表示不关联；显式授权 ID 覆盖角色默认。重复创建同一会话不会覆盖后来手动保存的选择或触发模型请求。|
| `GET /api/v1/chats/:sid` | 取历史、正在生成的部分文字、回合 ID、起始时间、最近终态和同一水位的游标。|
| `POST /api/v1/chats/:sid/turns` | `{clientRequestId,text,model,attachments?}`。可选 `attachments` 最多是本会话的 4 个上传 ID，并非路径；顺序纳入幂等比较。同一请求 ID 再试不会重开上游请求。新请求在用户消息及幂等记录落盘后回 `202`；相同 ID 与同内容重复调用返回原回合，内容不同时为 `409`。|
| `GET /api/v1/chats/:sid/workspace` | 读取当前会话的绑定及修订号：未关联时为 `workspace:null`；已关联仅返回项目 ID、可显示的名称、当前可用性和来源（`manual` 或 `role`）。挂载失效后名称为 `null`。|
| `PATCH /api/v1/chats/:sid/workspace` | `{workspaceId,revision}`，其中 `workspaceId:null` 是明确解除关联。目录路径不是请求字段；条件写入和严格落盘成功后才使其他窗口的列表失效。此操作不会读取项目文件或改变模型请求。|
| `GET /api/v1/chats/:sid/preferences` | 当前会话标题、自定义标题、归档状态、模型选项和该会话版本。版本用于条件写入，不是访问凭证。|
| `PATCH /api/v1/chats/:sid/preferences` | `{revision,set}` 只改指定字段（如 `customTitle:null`、`archived:true` 或 `model:null`）。取得持久化回执后更新 UI，同版本并发写不能静默覆盖。普通 `model` 字符串请求保持兼容；`model:null` 发送表示由服务端选择该时刻的默认模型。|
| `GET /api/v1/conversation-status/reads` | 返回当前所有者可确认、已落盘且有可见内容的会话 `{id,updatedAt,readAt,unread}`。空会话、在途回合、无法展示的历史和孤立的原生已读记录不会被当作已看过。 |
| `POST /api/v1/chats/:sid/read-state` | `{updatedAt,cursor}` 只确认当前已显示的持久版本。忙碌、陈旧游标或错误会话均不会推进标记。返回确切水位；仅新写入才使会话列表失效，文件仅包含时间戳。 |
| `POST /api/v1/chats/:sid/context-usage` | 只读。`{model:null}` 使用当前会话固定模型、角色偏好或全局默认；传完整引用只核对是否仍与生效模型相符，不会覆写设置。`source` 为 `none`、`estimate`、`live`、`measured` 或 `unavailable`；模型不存在时不虚构窗口或读数。`compaction` 固定为 `inactive`。 |
| `WS /api/v1/chats/stream` | 登录所有者的只读列表失效通知。首帧 `sessions-snapshot` 给出真实水位，之后 `sessions-changed` 触发重新 GET 列表；重连和服务重启都重新取快照。通知不含会话名称、ID、正文或其他标签的操作。|
| `POST /api/v1/chats/:sid/stop` | `{turnId}` 只停止目标回合。重建进程不会重发未完成的上游请求。|
| `POST /api/v1/chats/:sid/attachments` | 当前所有者把文件字节作为 `application/octet-stream` 上传；`x-deva-file-name` 是 UTF-8 文件名的无填充 base64url，`x-deva-file-type` 是所选内容类型。返回不透明附件 ID 和显示元数据，不触发模型请求。|
| `DELETE /api/v1/chats/:sid/attachments/:id` | 幂等撤回未发送的草稿；已经确认的会话历史独立保存。|
| `GET /api/v1/chats/:sid/attachments/:id/preview` | 仅为本会话授权的静态图片返回经校验的原始字节；登录过期或异会话不提供内容。|
| `GET /api/v1/chats/:sid/deliveries` | 返回允许导出的已完成回复、确认的交付组和分页游标。只传元数据，组内序号是原条目的序号；不会广播文件内容或宿主绝对路径。|
| `POST /api/v1/chats/:sid/deliveries/reply` | `{turnId,format}`，格式为 `md` 或 `txt`。在当前会话的已确认回复中定位，不接收浏览器提供的文件名、路径或正文。同轮同格式重复调用返回同一组。|
| `GET /api/v1/chats/:sid/deliveries/:gid/items/:index/download` | 按交付记录和 `If-Match` 版本下载，响应使用 `Content-Disposition: attachment`。`preview` 同样验版本且仅返回经校验的静态图片；`POST …/locate` 提供当前受权项目的相对定位。|
| `WS /api/v1/chats/:sid/stream` | 只读、同源、按登录会话校验。首次订阅取快照；刷新可用最后实际应用的游标衔接，旧游标转为新快照。退出、会话过期、消费超时或服务关闭时释放连接。|

上下文占用的窗口沿用桌面模型配置和同源自动窗口表。有效的标准化输入量写入桌面原生 `lastInputTokens`，另有只供服务核验的会话、模型与回合凭据；后续回合没有自己的有效用量时，即使旧数字仍在原生文件中，也只返回估算。图片和 PDF 采用桌面分摊常数，文本附件按已保存的体积近似，不为展示读数去解码媒体。没有服务端压缩流程、费用计算或工具调用。某些协议只在整个响应结束时提供 usage，此时不会为了显示「实时」而提前推算成实测。

已读标记使用平坦的原生 JSON 映射，单文件最多 1 MiB / 8192 个标记；损坏、重复键、超限或无法验证的状态会返回错误，不用空映射覆盖。面向已验证的本地 Linux 常规卷：真实写入前使用固定的 `flock` 和只接收已打开文件描述符的扩展属性检查，遇到可见 ACL、xattr 或无法检查时保持只读；普通查询和同水位的重复确认不运行这些辅助程序。在生产配置中本服务持有数据卷的单写者锁，不应与桌面进程并行写同一份原件。

写入需要工作台登录 Cookie、匹配的 Origin 与 CSRF。通过反代访问时，对 WS 路径一并保留 Host、Origin、HTTP/1.1 Upgrade 和 Connection。不要把聊天数据、访问凭据或控制命令放入 WS URL；可选的 `cursor` 只是进度，不授予访问权。

当前限制：每轮输入 12 KiB，输出与思考通道各 64 Ki UTF-16 单元，每轮最长 5 分钟，每实例至多 8 个并行回合。每会话保留全部最多 256 个已受理请求以防重新计费；达到上限后仍可读、仍可重查旧请求，须另建会话才能发新消息。由本服务创建并通过索引校验的附件会话可续聊，快照只给出文件卡的元数据。已有普通桌面文本历史只读；缺少可验证索引的旧附件、工具和交互卡等复杂历史标记不兼容，不将残缺内容当作完整历史，也不覆盖原件。这些是开发阶段限制，不代表已实现完整桌面能力。
