import { matchesSkillEdit, retryableSkillRead, sameSkillRoles, skillProblem, type Catalog, type RoleOption, type SkillDocument,
  type SkillEdit, type SkillLibraryTransport, type SkillProblem, type SkillRoles, type SkillSummary } from './skill-library-transport'

export type RoleMode = 'all' | 'none' | 'selected'
export type RoleDraft = { base: string; mode: RoleMode; picked: string[]; review: boolean }
type RoleEditor = { draft: RoleDraft; options?: RoleOption[]; loading: boolean; error?: SkillProblem }
type Detail = { item: SkillSummary; document?: SkillDocument; loading: boolean; error?: SkillProblem }
type Feedback = { id: string; edit: SkillEdit; status: 'saving' | 'saved' | SkillProblem }
type ReadIssue = { problem: SkillProblem; retryable: boolean }
export type SkillLibraryState = {
  catalog?: Catalog; listing: boolean; listError?: SkillProblem; syncError?: SkillProblem; reconnecting?: boolean;
  selected?: Detail; roles?: RoleEditor; feedback?: Feedback
}

export function draftRoles(draft: RoleDraft): SkillRoles {
  return draft.mode === 'all' ? null : draft.mode === 'none' ? [] : draft.picked
}
function newDraft(item: SkillSummary): RoleDraft {
  return { base: item.revision, mode: item.roles === null ? 'all' : item.roles.length ? 'selected' : 'none',
    picked: item.roles ? [...item.roles] : [], review: false }
}
export function roleNeedsReview(draft: RoleDraft, item: SkillSummary): boolean {
  return draft.review || draft.base !== item.revision
}
export function invalidDraftRoles(editor: RoleEditor, item: SkillSummary): boolean {
  if (editor.draft.mode !== 'selected') return false
  return !editor.draft.picked.length || editor.draft.picked.some((id) =>
    !editor.options?.some((option) => option.id === id) && !item.roles?.includes(id))
}

// Keep a minimum spacing between empty waits even if a server answers immediately.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** One instance per open Skills pane. Only methods invoked by the pane's explicit controls open details or the role roster. */
export function createSkillLibrary(api: SkillLibraryTransport, onExpired: () => void, retryDelays: readonly number[] = [800, 1600, 3200]) {
  const lifetime = new AbortController()
  const listeners = new Set<() => void>()
  let state: SkillLibraryState = { listing: true }
  let listing: Promise<Catalog | undefined> | undefined
  let listIssue: ReadIssue | undefined
  let monitoring = false
  let started = false
  let detailRead: AbortController | undefined
  let rolesRead: AbortController | undefined

  const set = (patch: Partial<SkillLibraryState>): void => {
    if (lifetime.signal.aborted) return
    state = { ...state, ...patch }
    listeners.forEach((listener) => listener())
  }
  const failure = (error: unknown): SkillProblem => {
    const problem = skillProblem(error)
    if (problem === 'expired' && !lifetime.signal.aborted) {
      set({ catalog: undefined, selected: undefined, roles: undefined, feedback: undefined, listing: false,
        listError: 'expired', syncError: undefined, reconnecting: false })
      dispose()
      onExpired()
    }
    return problem
  }
  const readIssue = (error: unknown): ReadIssue => ({ problem: failure(error), retryable: retryableSkillRead(error) })
  const current = (id: string): SkillSummary | undefined => state.catalog?.skills.find((item) => item.id === id)
  const saving = (): boolean => state.feedback?.status === 'saving'

  function acceptCatalog(catalog: Catalog): void {
    set({ catalog, listError: undefined })
    if (state.syncError) return // Reconnect reconfirms even an unchanged selected revision.
    const selected = state.selected
    if (!selected) return
    const item = current(selected.item.id)
    if (!item || item.source !== 'custom') {
      detailRead?.abort()
      set({ selected: { item: selected.item, loading: false, error: 'missing' } })
    } else if (item.revision !== selected.item.revision || selected.error === 'missing') {
      void loadDetail(item)
    }
  }

  async function readCatalog(fresh = false): Promise<Catalog | undefined> {
    if (fresh) while (listing) await listing
    if (lifetime.signal.aborted) return undefined
    if (listing) return listing
    set({ listing: true })
    listing = api.list(lifetime.signal).then((catalog) => {
      if (lifetime.signal.aborted) return undefined
      listIssue = undefined
      acceptCatalog(catalog)
      return catalog
    }).catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        listIssue = readIssue(error)
        set({ listError: listIssue.problem })
      }
      return undefined
    }).finally(() => {
      listing = undefined
      set({ listing: false })
    })
    return listing
  }

  function pauseSync(issue: ReadIssue, reconnecting: boolean): void {
    detailRead?.abort()
    rolesRead?.abort()
    const { selected, roles } = state
    set({ syncError: issue.problem, reconnecting, selected: selected ? { item: selected.item, loading: false } : undefined,
      roles: roles ? { ...roles, loading: false, draft: { ...roles.draft, review: true } } : undefined })
  }

  async function reconfirm(): Promise<ReadIssue | undefined> {
    if (!await readCatalog(true) || lifetime.signal.aborted) return listIssue ?? { problem: 'unavailable', retryable: true }
    const selected = state.selected
    if (selected) {
      const item = current(selected.item.id)
      if (item?.source === 'custom') {
        const issue = await loadDetail(item, false)
        if (issue && state.selected && issue.problem !== 'missing') return issue
      } else {
        set({ selected: { item: selected.item, loading: false, error: 'missing' } })
      }
    }
    set({ syncError: undefined, reconnecting: false })
    return undefined
  }

  async function monitor(): Promise<void> {
    if (monitoring || !state.catalog || state.syncError || lifetime.signal.aborted) return
    monitoring = true
    let attempts = 0
    try {
      while (!lifetime.signal.aborted && state.catalog) {
        const began = Date.now()
        let issue: ReadIssue | undefined
        try {
          const change = await api.changes(state.catalog.revision, 8000, lifetime.signal)
          if (lifetime.signal.aborted) break
          attempts = 0 // A real Changes receipt re-arms the bounded reconnect allowance.
          if (change.changed && state.catalog.revision !== change.revision && !await readCatalog()) issue = listIssue
        } catch (error) {
          if (lifetime.signal.aborted) break
          issue = readIssue(error)
        }
        while (issue && !lifetime.signal.aborted) {
          const delay = issue.retryable ? retryDelays[attempts] : undefined
          pauseSync(issue, delay !== undefined)
          if (delay === undefined) return
          attempts++
          await pause(delay, lifetime.signal)
          if (!lifetime.signal.aborted) issue = await reconfirm()
        }
        const remaining = 400 - (Date.now() - began)
        if (remaining > 0 && attempts === 0) await pause(remaining, lifetime.signal)
      }
    } finally {
      monitoring = false
    }
  }

  async function loadDetail(item: SkillSummary, mayReconcile = true): Promise<ReadIssue | undefined> {
    detailRead?.abort()
    const read = new AbortController()
    detailRead = read
    set({ selected: { item, loading: true } })
    const reject = (issue: ReadIssue): ReadIssue => {
      set({ selected: { item, loading: false, error: issue.problem } })
      return issue
    }
    try {
      const document = await api.detail(item.id, read.signal)
      if (read.signal.aborted) return undefined
      if (!document || document.detail !== 'document') return reject({ problem: 'missing', retryable: false })
      if (document.revision !== item.revision) {
        // The document advanced after the catalog read. Show neither a stale document nor a stale write target.
        if (mayReconcile) void readCatalog(true)
        return reject({ problem: 'stale', retryable: false })
      }
      if (document.canConfigure !== item.canConfigure || document.enabled !== item.enabled ||
          !sameSkillRoles(document.roles, item.roles) || document.name !== item.name || document.description !== item.description)
        return reject({ problem: 'invalid', retryable: false })
      set({ selected: { item, document, loading: false } })
      return undefined
    } catch (error) {
      return read.signal.aborted ? undefined : reject(readIssue(error))
    }
  }

  function open(id: string): boolean {
    const item = current(id)
    if (lifetime.signal.aborted || state.selected || state.listError || state.syncError || item?.source !== 'custom') return false
    void loadDetail(item)
    return true
  }

  function closeRoles(): void {
    rolesRead?.abort()
    set({ roles: undefined })
  }
  function back(): void {
    detailRead?.abort()
    closeRoles()
    set({ selected: undefined })
  }

  async function refresh(): Promise<void> {
    if (lifetime.signal.aborted || state.reconnecting) return
    if (state.syncError) {
      set({ reconnecting: true })
      const issue = await reconfirm()
      if (issue && !lifetime.signal.aborted) pauseSync(issue, false)
      if (!issue) void monitor()
      return
    }
    if (await readCatalog(true)) {
      const selected = state.selected
      const item = selected && current(selected.item.id)
      if (item?.source === 'custom' && selected?.error && !selected.loading) void loadDetail(item)
      void monitor()
    }
  }

  function selectedWritable(): SkillSummary | undefined {
    const selected = state.selected
    const item = selected && current(selected.item.id)
    return item?.canConfigure === true && item.source === 'custom' && selected?.document?.revision === item.revision &&
      !state.listError && !state.syncError && !selected.error ? item : undefined
  }

  async function readRoles(review: boolean): Promise<void> {
    const editor = state.roles
    const item = selectedWritable()
    if (!editor || !item || saving() || lifetime.signal.aborted) return
    rolesRead?.abort()
    const read = new AbortController()
    rolesRead = read
    set({ roles: { ...editor, loading: true, error: undefined } })
    try {
      // A conflict review uses a fresh catalog and roster; reviewing never writes.
      const catalog = review ? await readCatalog(true) : state.catalog
      if (read.signal.aborted || !state.roles) return
      const latest = catalog?.skills.find((s) => s.id === item.id)
      if (!latest || latest.source !== 'custom' || !latest.canConfigure) {
        set({ roles: { ...state.roles, loading: false, error: state.listError ?? (latest ? 'readonly' : 'missing') } })
        return
      }
      const options = await api.roles(read.signal)
      if (read.signal.aborted || !state.roles) return
      const draft = state.roles.draft
      set({ roles: { draft: review ? { ...draft, base: latest.revision, review: false } : draft, options, loading: false },
        ...(review ? { feedback: undefined } : {}) })
      if (review) void monitor()
    } catch (error) {
      if (!read.signal.aborted && state.roles) set({ roles: { ...state.roles, loading: false, error: failure(error) } })
    }
  }

  function openRoles(): boolean {
    const item = selectedWritable()
    if (!item || state.roles || saving()) return false
    set({ roles: { draft: newDraft(item), loading: true }, feedback: undefined })
    void readRoles(false)
    return true
  }
  function setRoleMode(mode: RoleMode): void {
    if (!state.roles?.options || state.roles.loading || saving()) return
    set({ roles: { ...state.roles, draft: { ...state.roles.draft, mode } } })
  }
  function pickRole(id: string, checked: boolean): void {
    const editor = state.roles
    if (!editor?.options || editor.loading || saving() || editor.draft.mode !== 'selected') return
    const picked = editor.draft.picked
    if (checked ? !editor.options.some((item) => item.id === id) || picked.includes(id) : !picked.includes(id)) return
    const next = checked ? [...picked, id] : picked.filter((old) => old !== id)
    set({ roles: { ...editor, draft: { ...editor.draft, picked: next, mode: next.length ? 'selected' : 'none' } } })
  }

  async function save(item: SkillSummary, edit: SkillEdit): Promise<void> {
    if (lifetime.signal.aborted || saving() || state.listError || state.syncError || item.source !== 'custom' || !item.canConfigure ||
        current(item.id)?.revision !== item.revision || matchesSkillEdit(item, edit)) return
    set({ feedback: { id: item.id, edit, status: 'saving' } })
    try {
      await api.patch(item, edit, lifetime.signal)
      if (lifetime.signal.aborted) return
      // Confirm the projection actually visible after writing. A list toggle never reads private document text.
      const result = await readCatalog(true)
      if (lifetime.signal.aborted) return
      const saved = result?.skills.find((s) => s.id === item.id)
      if (!result) throw new Error('Could not confirm skill preferences')
      if (!saved) { rejectSave(item, edit, 'missing'); return }
      if (!saved.canConfigure || saved.source !== 'custom') { rejectSave(item, edit, 'readonly'); return }
      if (!matchesSkillEdit(saved, edit)) { rejectSave(item, edit, 'stale'); return }
      if ('roles' in edit) closeRoles()
      set({ feedback: { id: item.id, edit, status: 'saved' } })
    } catch (error) {
      if (lifetime.signal.aborted) return
      const problem = failure(error)
      rejectSave(item, edit, problem)
      // A dropped receipt or conflict may already have changed disk. Refresh reads only, never replay PATCH.
      void readCatalog(true)
    }
  }
  function rejectSave(item: SkillSummary, edit: SkillEdit, problem: SkillProblem): void {
    const editor = state.roles
    set({ feedback: { id: item.id, edit, status: problem },
      ...(editor && 'roles' in edit ? { roles: { ...editor, draft: { ...editor.draft, review: true } } } : {}) })
  }
  function toggle(id: string): void {
    const item = current(id)
    if (item && (!state.selected || selectedWritable()?.id === id) && !state.roles) void save(item, { enabled: !item.enabled })
  }
  function saveRoles(): void {
    const item = selectedWritable()
    const editor = state.roles
    if (!item || !editor?.options || editor.loading || editor.error || roleNeedsReview(editor.draft, item) || invalidDraftRoles(editor, item)) return
    void save(item, { roles: draftRoles(editor.draft) })
  }
  function dispose(): void {
    lifetime.abort()
    detailRead?.abort()
    rolesRead?.abort()
    listeners.clear()
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    start(): void { if (!started) { started = true; void refresh() } },
    dispose, refresh, open, back, toggle, openRoles, closeRoles, setRoleMode, pickRole, saveRoles,
    reviewRoles: () => readRoles(true)
  }
}
export type SkillLibraryController = ReturnType<typeof createSkillLibrary>
