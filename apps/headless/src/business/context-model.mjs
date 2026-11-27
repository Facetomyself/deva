import { autoContextWindow, CONTEXT_WINDOW_RANGE, DEFAULT_CONTEXT_WINDOW, validLimit } from '../../dist/context-limits.mjs'
import { assertSettingsCurrent, readSettingsFile } from './settings-file.mjs'
import { hydrate, section, SettingsError } from './settings-schema.mjs'

const adapters = new Set(['openai','responses','anthropic'])
export function isContextModelRef(ref) {
  if (typeof ref !== 'string' || !ref.isWellFormed() || ref !== ref.trim() || ref.length>609 || /[\x00-\x1f\x7f]/u.test(ref)) return false
  const colon=ref.indexOf(':'), provider=ref.slice(0,colon), model=ref.slice(colon+1)
  return colon>0 && model.length>0 && model===model.trim() && Buffer.byteLength(model)<=512 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(provider) && !['__proto__','constructor','prototype'].includes(provider)
}

/** Caller holds the settings-directory queue. Only look up a configured enabled chat
 * model and its window; do not open the secret vault, request /models or hydrate credentials. */
export async function contextModelFromFile(directory, ref, previouslyPresent) {
  if (ref !== null && !isContextModelRef(ref)) throw new SettingsError('INVALID')
  const {raw,info}=await readSettingsFile(directory)
  if (!info && previouslyPresent) throw new SettingsError('CORRUPT')
  const {models}=section(raw,true), catalogue=hydrate(models)
  const effective=ref ?? catalogue.activeModelId
  let selected=null
  if (isContextModelRef(effective)) {
    const colon=effective.indexOf(':'), pid=effective.slice(0,colon), modelId=effective.slice(colon+1)
    const p=catalogue.providers.find(p=>p.id===pid && p.purpose==='llm' && p.enabled && adapters.has(p.adapter) && p.apiHost)
    const model=p?.models.find(m=>m.id===modelId && m.enabled)
    if (model) {
      const fallback=raw.compaction?.defaultWindow
      const window=model.contextWindow ?? autoContextWindow(modelId,validLimit(fallback,CONTEXT_WINDOW_RANGE) ? fallback : DEFAULT_CONTEXT_WINDOW)
      selected={modelRef:effective,modelId,adapter:p.adapter,contextWindow:window}
    }
  }
  await assertSettingsCurrent(directory,info)
  return {selected,present:!!info}
}
