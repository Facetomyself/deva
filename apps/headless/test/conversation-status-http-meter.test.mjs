import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import {
  assertPrivate, bounds, chat, disabledRef, fixtures, modelRef, post, question, reads, reply,
  rolePrompt, usage, workbench
} from './conversation-status-fixture.mjs'

const unavailable = { modelRef: null, usage: null, source: 'unavailable', compaction: 'inactive' }
const meter = (adapter, source, used) => ({ modelRef: modelRef(adapter),
  usage: { used, estimated: source === 'estimate', window: fixtures[adapter].window, trigger: null }, source, compaction: 'inactive' })
const meterFor = (browser, sid, model = null) => browser.request(usage(sid), post({ model }))

function estimate(adapter, value) {
  assert.ok(Number.isSafeInteger(value.usage?.used) && value.usage.used > 0)
  assert.deepEqual(value, meter(adapter, 'estimate', value.usage.used))
  assert.notEqual(value.usage.used, fixtures[adapter].used)
  return value.usage.used
}

async function pin(owner, sid, model) {
  const path = `${chat(sid)}/preferences`
  const { revision } = await owner.request(path)
  return owner.request(path, { method: 'PATCH', body: { revision, set: { model } } })
}

async function models(owner, set) {
  const { revision } = await owner.request('settings')
  return owner.request('settings', { method: 'PATCH', body: { revision, set: { models: set } } })
}

test('authenticated meter follows real OpenAI Chat, Anthropic and Responses usage without upstream status requests', bounds, async t => {
  const fx = await workbench(t)
  const { owner, upstream } = fx
  const roleName = 'Private synthetic fixture role'
  const { role } = await owner.request('personas', post({ name: roleName, prompt: rolePrompt, enabled: true, model: modelRef('anthropic') }))
  const sid = Object.fromEntries(Object.keys(fixtures).map(adapter => [adapter, randomUUID()]))
  await fx.create(sid.openai)
  await fx.create(sid.anthropic, { personaId: role.id })
  await pin(owner, sid.anthropic, null) // Follow the role default rather than keeping its initial pin.
  await fx.create(sid.responses)
  await pin(owner, sid.responses, modelRef('responses'))

  for (const adapter of Object.keys(fixtures)) {
    assert.deepEqual(await meterFor(owner, sid[adapter]), meter(adapter, 'none', null))
    assert.deepEqual(await meterFor(owner, sid[adapter], modelRef(adapter)), meter(adapter, 'none', null))
  }
  assert.deepEqual(await meterFor(owner, sid.openai, disabledRef), unavailable)
  assert.deepEqual(await meterFor(owner, sid.openai, 'qa-openai:removed-fixture-model'), unavailable)
  assert.deepEqual(await meterFor(owner, sid.openai, modelRef('responses')), unavailable)
  assert.deepEqual(await owner.request(reads), { entries: [] })
  assert.equal(upstream.calls.length, 0)

  for (const [adapter, { used, path }] of Object.entries(fixtures)) {
    const id = sid[adapter]
    const { turnId } = await fx.send(id, `measured-${adapter}`, adapter === 'responses' ? modelRef(adapter) : null)
    const finished = await fx.complete(id, turnId)
    assert.deepEqual(finished.state.messages.map(message => message.content), [question, reply])
    const native = await fx.native(id)
    assert.equal(native.lastInputTokens, used, `normalized ${adapter} input persists in the native field`)
    assert.equal(native._devaHeadlessTextTurns.requests.at(-1).turnId, turnId)
    assert.equal(upstream.calls.at(-1).path, path)
    const chatBytes = await readFile(fx.sessionFile(id), 'utf8')
    const count = upstream.calls.length
    const measured = await meterFor(owner, id, modelRef(adapter))
    assert.deepEqual(measured, meter(adapter, 'measured', used))
    assert.deepEqual(await meterFor(owner, id), measured)
    assertPrivate(measured, [fx.configPath, fx.sessionFile(id), fx.providerOrigin, roleName])
    assert.deepEqual(await owner.request(chat(id)), finished)
    assert.equal(await readFile(fx.sessionFile(id), 'utf8'), chatBytes, 'metering does not persist or edit history')
    assert.equal(upstream.calls.length, count)
  }
  assert.deepEqual(upstream.calls.map(call => call.path), Object.values(fixtures).map(adapter => adapter.path))
  const roleCall = upstream.calls.find(call => call.path === fixtures.anthropic.path)
  assert.ok(JSON.stringify(roleCall.body.messages).includes(rolePrompt), 'the trusted role actually participates in the ordinary Send')
  assertPrivate(await owner.request(reads), [fx.configPath, fx.providerOrigin, roleName, role.id])
  assert.equal(upstream.calls.length, 3)

  await models(owner, { activeModelId: modelRef('responses') })
  estimate('responses', await meterFor(owner, sid.openai))
  assert.deepEqual(await meterFor(owner, sid.openai, modelRef('openai')), unavailable)
  assert.equal((await fx.native(sid.openai)).lastInputTokens, fixtures.openai.used,
    'a stored measurement for the old model is untouched but unavailable for the newly effective model')
  await models(owner, { activeModelId: modelRef('openai') })
  assert.deepEqual(await meterFor(owner, sid.openai), meter('openai', 'measured', fixtures.openai.used))
  assert.equal(upstream.calls.length, 3)

  // Same chat and same model: an in-progress turn and then a new turn lacking usage must not
  // report the prior valid measured receipt. A second measured Send then challenges invalid data.
  upstream.mode('hold')
  const running = await fx.send(sid.openai, 'running')
  await fx.untilSnapshot(sid.openai, state => state.active?.text === reply)
  estimate('openai', await meterFor(owner, sid.openai))
  assert.equal(upstream.calls.length, 4)
  upstream.release()
  await fx.complete(sid.openai, running.turnId)
  assert.deepEqual(await meterFor(owner, sid.openai), meter('openai', 'measured', fixtures.openai.used))

  const estimates = []
  for (const mode of ['missing', 'invalid']) {
    if (mode === 'invalid') {
      await fx.complete(sid.openai, (await fx.send(sid.openai, 'remeasure')).turnId)
      assert.deepEqual(await meterFor(owner, sid.openai), meter('openai', 'measured', fixtures.openai.used))
    }
    upstream.mode(mode)
    const text = `Synthetic ${mode} token receipt. `.repeat(40)
    const { turnId } = await fx.send(sid.openai, mode, null, text)
    const finished = await fx.complete(sid.openai, turnId)
    assert.equal(finished.state.messages.at(-2).content, text)
    const native = await fx.native(sid.openai)
    assert.equal(native._devaHeadlessTextTurns.requests.at(-1).turnId, turnId)
    assert.ok(native.lastInputTokens === undefined || native.lastInputTokens === fixtures.openai.used,
      'invalid or absent usage must not replace the prior native measurement with a new number')
    const count = upstream.calls.length
    estimates.push(estimate('openai', await meterFor(owner, sid.openai)))
    assert.equal(upstream.calls.length, count)
  }
  assert.ok(estimates[1] > estimates[0], 'fallback includes current, growing conversation history')
  assert.equal(upstream.calls.length, 7)

  // A global model update affects only followers of that default. A different requested
  // model never gets a measured result from the history's old match or a misleading estimate.
  await models(owner, { activeModelId: modelRef('responses') })
  estimate('responses', await meterFor(owner, sid.openai))
  assert.deepEqual(await meterFor(owner, sid.openai, modelRef('openai')), unavailable)
  assert.deepEqual(await meterFor(owner, sid.anthropic), meter('anthropic', 'measured', fixtures.anthropic.used))
  assert.deepEqual(await meterFor(owner, sid.responses), meter('responses', 'measured', fixtures.responses.used))
  await pin(owner, sid.openai, modelRef('anthropic'))
  estimate('anthropic', await meterFor(owner, sid.openai))
  assert.deepEqual(await meterFor(owner, sid.openai, modelRef('responses')), unavailable)

  // Both requested and server-selected unavailable paths, including a disabled actual pin
  // and a role default whose formerly measured provider was removed.
  const altered = fx.providers.filter(provider => provider.id !== 'qa-anthropic').map(provider => provider.id === 'qa-responses'
    ? { ...provider, models: provider.models.map(model => ({ ...model, enabled: false })) } : provider)
  await models(owner, { providers: altered, activeModelId: modelRef('openai') })
  assert.deepEqual(await meterFor(owner, sid.openai), unavailable)
  assert.deepEqual(await meterFor(owner, sid.anthropic, modelRef('anthropic')), unavailable)
  assert.deepEqual(await meterFor(owner, sid.responses), unavailable)
  assert.deepEqual(await meterFor(owner, sid.responses, modelRef('responses')), unavailable)
  await models(owner, { providers: fx.providers, activeModelId: modelRef('openai') })
  const stable = await meterFor(owner, sid.responses)
  assert.deepEqual(stable, meter('responses', 'measured', fixtures.responses.used))
  assert.equal(upstream.calls.length, 7)

  await fx.restart()
  assert.deepEqual(await owner.request(usage(sid.responses), post({ model: null }, 401)), { error: 'auth' })
  const fresh = await fx.login()
  assert.deepEqual(await meterFor(fresh, sid.responses), stable)
  assert.deepEqual(await meterFor(fresh, sid.anthropic), meter('anthropic', 'measured', fixtures.anthropic.used))
  estimate('anthropic', await meterFor(fresh, sid.openai))
  await assert.rejects(stat(fx.readFilePath), { code: 'ENOENT' })
  assert.equal(upstream.calls.length, 7)
})
