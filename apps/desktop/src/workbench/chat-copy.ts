import type { Locale } from './first-use-copy'
import type { ChatTurn } from './chat-transport'

export function chatCopy(locale: Locale) {
  return locale === 'en' ? {
    scope: 'Text chat only. Roles, tasks, bots, tools, attachments and workspace access are desktop features.',
    unavailable: 'Available in the desktop app', empty: 'Start a conversation',
    loading: 'Loading conversation…', reconnecting: 'Syncing conversation…', missing: 'This conversation is no longer available.',
    readOnly: 'Read-only desktop conversation', unsupported: 'This desktop history contains features the text workbench does not display. Open it in the desktop app.',
    limit: 'This conversation reached its turn limit. Start a new conversation to keep chatting.', locked: 'This conversation is currently read-only.',
    reading: 'Waiting for reply…', running: 'Replying…', sent: 'Submitting message…', done: 'Reply complete', aborted: 'Reply stopped', failed: 'The reply failed.',
    interrupted: 'The reply was interrupted.', shutdown: 'The reply was stopped by server shutdown.',
    capped: 'The reply reached the output limit.', emptyReply: 'The model returned an empty reply.',
    refusal: 'The model declined to answer.', repeated: 'The reply ended after the model repeated itself.',
    timeout: 'The reply timed out.', unexpectedTool: 'The model attempted to call a tool; this conversation only supports text.',
    storageUnconfirmed: 'The reply could not be confirmed in storage.',
    selectModel: 'Select an enabled model. Configure providers, keys and models in Model settings.',
    turnFailure: 'Could not confirm the message. The draft was kept; sending the same draft retries the same request.',
    busy: 'A reply is already in progress in this conversation.', modelFailure: 'Check the selected model and provider in Model settings.',
    listFailure: 'Could not load conversations.', createFailure: 'Could not confirm a new conversation. Try New conversation again.',
    stopFailure: 'Could not confirm the stop request.', reloadList: 'Retry',
    limits: '{turns} turns per conversation · 12 KiB input · 65,536 UTF-16 code units of output', input: 'Message the assistant…', inputLimit: 'Messages can contain up to 12 KiB of UTF-8 text.', previous: 'Show earlier messages'
  } : {
    scope: '仅开放文本对话。角色、任务、机器人、工具、附件和工作区请在桌面应用中使用。',
    unavailable: '请在桌面应用中使用此功能', empty: '开启一段对话',
    loading: '正在加载对话…', reconnecting: '正在同步对话…', missing: '这段对话已失效。',
    readOnly: '桌面历史 · 只读', unsupported: '这段桌面历史包含文本工作台尚未支持的内容，请在桌面应用中查看。',
    limit: '这段对话已达轮次上限，可新建对话继续。', locked: '这段对话目前为只读。',
    reading: '等待回复…', running: '正在回复…', sent: '正在提交消息…', done: '回复已完成', aborted: '回复已停止', failed: '回复失败。',
    interrupted: '回复已中断。', shutdown: '服务关闭，回复已停止。',
    capped: '回复已达输出上限。', emptyReply: '模型返回了空回复。',
    refusal: '模型未回答这条消息。', repeated: '模型重复输出，回复已结束。',
    timeout: '回复超时。', unexpectedTool: '模型尝试调用工具；这个对话仅支持文本。',
    storageUnconfirmed: '回复的保存结果尚未确认。',
    selectModel: '请选择已启用的模型。可在模型设置中配置服务商、密钥和模型。',
    turnFailure: '消息发送结果尚未确认。已保留草稿，再次提交原草稿会使用同一个请求。',
    busy: '这段对话已有一条回复正在进行。', modelFailure: '请在模型设置中检查所选模型和服务商。',
    listFailure: '加载对话列表失败。', createFailure: '新建对话的结果尚未确认，可再次点击新建对话。',
    stopFailure: '停止请求的结果尚未确认。', reloadList: '重试',
    limits: '每段对话 {turns} 轮 · 输入 12 KiB · 输出 65,536 个 UTF-16 码元', input: '跟助手说点什么…', inputLimit: '单条消息最多 12 KiB UTF-8 文本。', previous: '显示更早的消息'
  }
}
export type ChatCopy = ReturnType<typeof chatCopy>

export function turnLabel(c: ChatCopy, last: ChatTurn): string {
  switch (last.reason) {
    case 'shutdown': return c.shutdown
    case 'truncated': return c.capped
    case 'empty': return c.emptyReply
    case 'repeated': return c.repeated
    case 'refusal': return c.refusal
    case 'timeout': return c.timeout
    case 'unexpected_tool': return c.unexpectedTool
    case 'storage_unconfirmed': return c.storageUnconfirmed
  }
  if (last.status === 'aborted') return c.aborted
  if (last.status === 'interrupted') return c.interrupted
  return last.status === 'completed' ? c.done : c.failed
}
