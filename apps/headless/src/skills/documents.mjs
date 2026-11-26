import { isAbsolute, resolve } from 'node:path'
import { BUILTIN_SKILL_CATALOG } from '../../dist/library-core.mjs'
import { fail } from './documents-errors.mjs'
import { readSkillDetail, readSkillSummary } from './documents-format.mjs'
import { isSkillId } from './documents-ids.mjs'
import { nativeSkillDocuments, revision } from './documents-native.mjs'

const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const builtin = BUILTIN_SKILL_CATALOG.map(summary => Object.freeze({
  ...summary,
  documentRevision: revision(['deva-builtin-skill-summary-v1', summary.id, summary.name, summary.description, summary.source])
}))
const builtinById = new Map(builtin.map(item => [item.id, item]))
const asStamp = ({ id, documentRevision }) => ({ id, documentRevision })

/** Owner-only native document projection. The synchronous factory performs no filesystem IO. */
export function openSkillDocuments({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.isWellFormed() || dataDir.includes('\0') || !isAbsolute(dataDir) ||
      dataDir === '/' || Buffer.byteLength(dataDir) > 4095 || resolve(dataDir) !== dataDir) fail('skill_invalid')
  const { inspect, assertOpen, close } = nativeSkillDocuments(dataDir.slice(1).split('/'))
  return Object.freeze({
    list() {
      const custom = []
      inspect(undefined, (id, documentRevision, read) => {
        const { name, description } = read((size, bytes) => readSkillSummary(id, size, bytes))
        custom.push({ id, name, description, source: 'custom', documentRevision })
      })
      custom.sort((a, b) => a.name.localeCompare(b.name) || byId(a, b))
      return [...builtin.map(item => ({ ...item })), ...custom]
    },
    get(id) {
      assertOpen()
      if (!isSkillId(id)) fail('skill_invalid')
      const item = builtinById.get(id)
      if (item) return { ...item, detail: 'builtin' }
      let document = null
      inspect(id, (id, documentRevision, read) => {
        const fields = read((size, bytes) => readSkillDetail(id, size, bytes))
        document = { ...fields, source: 'custom', documentRevision, detail: 'document' }
      })
      return document
    },
    stamps() {
      const rows = builtin.map(asStamp)
      inspect(undefined, (id, documentRevision) => rows.push({ id, documentRevision }))
      return rows.sort(byId)
    },
    stamp(id) {
      assertOpen()
      if (!isSkillId(id)) fail('skill_invalid')
      const item = builtinById.get(id)
      if (item) return item.documentRevision
      let current = null
      inspect(id, (_id, revision) => { current = revision })
      return current
    },
    close
  })
}
