import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTextTurns } from '../src/chat/text-turns.mjs'
import { createEventJournal } from '../src/events/index.mjs'

const target = 'prefs-race:model'
const provider = { adapter: 'openai', purpose: 'llm', apiHost: 'https://fixture.invalid/v1', enabled: true, models: [{ id: 'model', enabled: true }] }

test('model settings lookup rechecks CAS and owner immediately before committing', { timeout: 5000 }, async t => {
  const dataDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-preferences-race-'))
  const journal = createEventJournal()
  let lookup = Promise.withResolvers()
  const turns = createTextTurns({ dataDir, journal, settings: { getProvider: () => lookup.promise } })
  t.after(async () => { await turns.close(); journal.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
  const { id } = turns.create()
  const initial = turns.getPreferences(id)
  const slow = turns.patchPreferences(id, { revision: initial.revision, set: { model: target } })
  const rename = await turns.patchPreferences(id, { revision: initial.revision, set: { customTitle: 'fast editor' } })
  lookup.resolve(provider)
  await assert.rejects(slow, { status: 409, code: 'preferences_conflict' })
  assert.deepEqual(turns.getPreferences(id), rename)
  lookup = Promise.withResolvers()
  let activeLogin = true
  const afterRevocation = turns.patchPreferences(id, { revision: rename.revision, set: { model: target } }, () => {
    if (!activeLogin) throw Object.assign(Error('expired login'), { code: 'AUTH_FAILED' })
  })
  activeLogin = false
  lookup.resolve(provider)
  await assert.rejects(afterRevocation, { code: 'AUTH_FAILED' })
  assert.deepEqual(turns.getPreferences(id), rename)
})
