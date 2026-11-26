import type { ChatSummary } from './chat-transport'

export function sessionAfterRefresh(sessions: ChatSummary[], selected: string | null, saved: string | null, grouped: boolean): string | null {
  // A list invalidation is not a navigation action. In the owner workbench an archived (or now missing)
  // selected conversation keeps its pane and drafts until the user chooses another conversation.
  if (grouped && selected) return selected
  const wanted = selected ?? saved
  if (wanted && sessions.some((row) => row.id === wanted)) return wanted
  return (grouped ? sessions.find((row) => !row.archived) : undefined)?.id ?? sessions[0]?.id ?? null
}

/** At most one GET in flight, plus one trailing GET for all invalidations received during it. */
export function createListRefresh<T>(read: () => Promise<T>, updated: (value: T) => void, failed: (error: unknown) => void) {
  let active = true
  let pending = false
  let running = false
  let revision = 0
  async function run(): Promise<void> {
    while (active && pending) {
      pending = false
      const expected = revision
      try {
        const next = await read()
        if (active && revision === expected) updated(next)
      } catch (error) {
        if (active && revision === expected) failed(error)
      }
    }
    running = false
  }
  function request(): void {
    if (!active) return
    pending = true
    if (running) return
    running = true
    queueMicrotask(() => void run())
  }
  return {
    request,
    // A locally acknowledged mutation is newer than any outstanding read started before it.
    afterWrite() { ++revision; request() },
    close() { active = false }
  }
}
