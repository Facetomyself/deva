/** 由宿主提供；纯适配器只依赖 Fetch/Web Streams 接口与错误描述。 */
export interface ProviderTransport {
  httpFetch: (url: string, init: RequestInit) => Promise<Response>
  describeNetError: (error: unknown) => string
  isEn: () => boolean
}

export interface ProviderDependencies extends Omit<ProviderTransport, 'isEn'> {
  getAppVersion: () => string
  /** 按服务商取出站凭据；调用方负责绑定 providerId 与经校验的目标地址。 */
  getSecret: (providerId: string) => string | null | undefined | Promise<string | null | undefined>
  /** 按服务商取自定义头；核心会归一头名并过滤保留头。 */
  providerCustomHeaders: (providerId: string) => Record<string, string> | null | undefined
  /** 按请求时的宿主语言生成错误文案；缺省为中文。 */
  isEn?: ProviderTransport['isEn']
}

export type ProviderRuntime = ProviderDependencies & ProviderTransport

export type AdapterKind = 'anthropic' | 'openai' | 'responses'

export interface StreamChatConfig {
  adapter: AdapterKind
  providerId: string
  baseURL: string
}
