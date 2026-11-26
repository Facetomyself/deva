import type { Message } from '../providers/types'
import { getDevaHome } from './config'
import { createMediaStore } from './media-store-core'

let desktopMedia: ReturnType<typeof createMediaStore> | undefined

/** Desktop chat, subagent transcripts and the startup sweep share one codec and cache. */
export function getDesktopMediaStore(): ReturnType<typeof createMediaStore> {
  return (desktopMedia ??= createMediaStore(getDevaHome()))
}

export function mediaReplacer(key: string, value: unknown): unknown {
  return getDesktopMediaStore().mediaReplacer(key, value)
}

export function hydrateMessages(messages: Message[]): void {
  getDesktopMediaStore().hydrateMessages(messages)
}

export function sweepMedia(): Promise<void> {
  return getDesktopMediaStore().sweepMedia()
}
