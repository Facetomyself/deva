import type { DevaApi } from '../shared/host-api'
import { createMount, type WorkbenchView } from './mount'

let mount: ReturnType<typeof createMount> | undefined

/** 稳定的 ES 模块入口。api 来自本地已编译的浏览器适配器；服务器只返回数据。 */
export function mountWorkbench(api: DevaApi, view: WorkbenchView = 'workbench'): Promise<void> {
  if (!mount) {
    if (!document.getElementById('root')) throw new Error('Missing workbench root element')
    mount = createMount(window, {
      workbench: () => import('../renderer/src/main'),
      browser: () => import('../renderer/src/browser-main')
    })
  }
  return mount(api, view)
}
