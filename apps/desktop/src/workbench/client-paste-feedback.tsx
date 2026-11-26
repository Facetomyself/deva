import { useEffect, useState } from 'react'
import { useI18n } from '../renderer/src/i18n/i18n'
import type { ClientPasteState } from './client-clipboard'

type State = ClientPasteState | 'locked'
const labels = {
  en: { pasted: 'Text pasted into this draft.', 'not-text': 'The clipboard has no plain text to paste.',
    'too-large': 'Paste up to 256 KiB of plain text at a time. The draft was kept.',
    unavailable: 'Paste was not confirmed. The clipboard is local to your browser.', locked: 'Pasting is disabled while this workbench is locked.' },
  'zh-CN': { pasted: '文本已粘贴到当前草稿。', 'not-text': '剪贴板里没有可粘贴的纯文本。',
    'too-large': '单次粘贴上限为 256 KiB；原草稿已保留。', unavailable: '尚未确认粘贴结果；剪贴板属于当前浏览器。', locked: '工作台锁定期间已停用粘贴。' }
}
export function useClientPasteNotice() {
  const [notice, set] = useState<{state: State}>()
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => set(undefined), notice.state === 'pasted' ? 1800 : 6500)
    return () => window.clearTimeout(timer)
  }, [notice])
  return { state:notice?.state, report:(state: State): void => set({state}) }
}
export function ClientPasteFeedback({ state }: { state?: State }): React.JSX.Element | null {
  const { locale } = useI18n()
  return state ? <p data-testid="workbench-paste-status" data-status={state} className="wb-chat__model"
    role={state==='pasted'?'status':'alert'}>{labels[locale][state]}</p> : null
}
