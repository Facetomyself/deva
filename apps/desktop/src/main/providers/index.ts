import { app } from 'electron'
import { describeNetError, httpFetch } from '../http'
import { isEn } from '../locale'
import { providerCustomHeaders } from '../services/model-resolve'
import { getSecret } from '../services/secrets'
import { createProviderCore } from './core'

// 桌面默认仍走 Chromium 网络栈；Node 宿主应直接导入 ./core 并注入自己的依赖。
export const { streamChat, listModels } = createProviderCore({
  httpFetch,
  describeNetError,
  getAppVersion: () => app.getVersion(),
  getSecret,
  providerCustomHeaders,
  isEn
})

export { normalizeMessages } from './core'
export type { AdapterKind, GenerateRequest, StreamChatConfig, StreamEvent } from './core'
