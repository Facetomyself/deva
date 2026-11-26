import type { DevaApi } from '../shared/host-api'

/** 由完成登录及配置引导的 Web 宿主调用；模块导入本身不读取 DOM，也不启动 React。 */
export type WorkbenchView = 'workbench' | 'browser'

type Modules = Record<WorkbenchView, () => Promise<unknown>>

/** 同一文档只能由同一个宿主启动一次。窗口/设备切换需要全新的页面，避免沿用旧凭据。 */
export function createMount(target: object, modules: Modules) {
  let mounted: { view: WorkbenchView; api: DevaApi; done: Promise<void> } | undefined
  return (api: DevaApi, view: WorkbenchView = 'workbench'): Promise<void> => {
    if (view !== 'workbench' && view !== 'browser') throw new TypeError('Unknown workbench view')
    if (mounted) {
      if (mounted.view !== view || mounted.api !== api) throw new Error('A different host is already mounted')
      return mounted.done
    }
    if ('deva' in target) throw new Error('The document already has a Deva host')
    // shell-common 在模块顶层判断平台；主题、字号、语言和布局在 React 首帧用 config.getSync。
    // 适配器（含本地快照）必须先就绪，严禁先 import 桌面入口再去补 window.deva。
    Object.defineProperty(target, 'deva', { value: api, enumerable: false, writable: false, configurable: false })
    const done = Promise.resolve().then(modules[view]).then(() => undefined)
    mounted = { api, view, done }
    return done
  }
}
