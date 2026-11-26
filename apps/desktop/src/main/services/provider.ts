import { ipcMain } from 'electron'
import { listModels, type StreamChatConfig } from '../providers'

/** 渲染层只拿到模型清单或标准错误；凭据留在主进程。 */
export function registerProviderIpc(): void {
  ipcMain.handle('provider:list-models', (_e, cfg: StreamChatConfig) => listModels(cfg))
}
