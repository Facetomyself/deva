import type {
  ChatEventPayload,
  DevaApi,
  PickedAttachment,
  RewindStatus,
  TaskRecord
} from './host-api'

type Equal<L, R> = (<T>() => T extends L ? 1 : 2) extends
  (<T>() => T extends R ? 1 : 2) ? true : false
type Expect<T extends true> = T

type DropEntry = Awaited<ReturnType<DevaApi['fs']['droppedEntries']>>[number]
type CreateTask = Awaited<ReturnType<DevaApi['tasks']['create']>>
type RewindApply = Awaited<ReturnType<DevaApi['chat']['rewindApply']>>
type RemoteScan = Awaited<ReturnType<DevaApi['remote']['scanStart']>>

// Compile-only signatures and discriminants used by renderer callers.
export type HostApiTypeTests = [
  Expect<Equal<Parameters<DevaApi['fs']['droppedEntries']>, [files: File[]]>>,
  Expect<Equal<Extract<DropEntry, null>, null>>,
  Expect<Equal<Extract<DropEntry, { file: unknown }>, { file: PickedAttachment }>>,
  Expect<Equal<Extract<DropEntry, { folder: unknown }>, { folder: { path: string; name: string } }>>,
  Expect<Equal<ReturnType<DevaApi['config']['getSync']>, Record<string, unknown>>>,
  Expect<Equal<ReturnType<DevaApi['config']['get']>, Promise<Record<string, unknown>>>>,
  Expect<Equal<DevaApi['chat']['onEvent'], (cb: (payload: ChatEventPayload) => void) => () => void>>,
  Expect<Equal<DevaApi['git']['onCommitMessageDelta'], (cb: (reqId: string, text: string) => void) => () => void>>,
  Expect<Equal<DevaApi['terminal']['write'], (id: string, data: string) => void>>,
  Expect<Equal<Parameters<DevaApi['fs']['attachmentImage']>, [path: string, full?: boolean]>>,
  Expect<Equal<Parameters<DevaApi['browser']['open']>, [opts?: { tab?: string; sessionId?: string }]>>,
  Expect<Equal<Extract<CreateTask, { ok: true }>['task'], TaskRecord>>,
  Expect<Equal<Extract<RewindApply, { ok: true }>['skipped'][number]['reason'], RewindStatus | 'error'>>,
  Expect<Equal<Extract<RewindApply, { ok: false }>['error'], 'no-session' | 'busy' | 'bad-turn'>>,
  Expect<Equal<Extract<RemoteScan, { ok: false }>, { ok: false; error: string }>>
]
