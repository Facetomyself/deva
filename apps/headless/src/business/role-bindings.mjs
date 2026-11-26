import { promises as fs } from 'node:fs'
import { openDirectory, childPath } from '../storage/private-files.mjs'
import { readSettingsFile } from './settings-file.mjs'
import { readCheckedText, withChildDirectory, statKey } from './personas-files.mjs'

// The roster owns the shared settings queue when this is called. Do not try to take it a
// second time. No model, tool or chat is run here. A missing/corrupt dependency is not a
// positive deletion permit; only a verified absence of references returns true.
export function checkRoleBindings(dataDir) {
  return async id => {
    const { directory } = await openDirectory(dataDir, { owned: true })
    try {
      const { raw } = await readSettingsFile(directory)
      if (raw.remote !== undefined) {
        if (!raw.remote || typeof raw.remote !== 'object' || Array.isArray(raw.remote) || (raw.remote.bots !== undefined && !Array.isArray(raw.remote.bots))) return false
        for (const bot of raw.remote.bots ?? []) {
          if (!bot || typeof bot !== 'object' || Array.isArray(bot)) return false
          const scope = bot.scope
          if (scope !== undefined && (!scope || typeof scope !== 'object' || Array.isArray(scope))) return false
          if (scope?.personas !== undefined && (!Array.isArray(scope.personas) || scope.personas.some(p => typeof p !== 'string') || scope.personas.includes(id))) return false
        }
      }
      return await withChildDirectory(directory, 'data', false, async (data, verifyData) => {
        if (!data) { await verifyData(); return true }
        return withChildDirectory(data, 'chats', false, async (chats, verifyChats) => {
          if (!chats) { await verifyChats(); await verifyData(); return true }
          let count = 0, bytes = 0
          const before = statKey(await chats.stat({ bigint: true }))
          const dir = await fs.opendir(childPath(chats, '.'))
          for await (const entry of dir) {
            if (++count > 4096) return false
            if (entry.name === '_index.json' || !entry.name.endsWith('.json')) continue
            if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,200}\.json$/.test(entry.name)) return false
            const bound = Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - bytes)
            if (bound < 1) return false
            const f = await readCheckedText(chats, entry.name, bound)
            if (!f) return false
            bytes += Number(f.info.size)
            const s = JSON.parse(f.raw)
            if (!s || s.id !== entry.name.slice(0, -5) || !Array.isArray(s.messages) || (s.personaId !== undefined && typeof s.personaId !== 'string')) return false
            if (s.personaId === id) return false
            if (s.members !== undefined && (!Array.isArray(s.members) || s.members.some(m => !m || m.personaId === id || (m.personaId !== undefined && typeof m.personaId !== 'string')))) return false
          }
          await verifyChats(); await verifyData()
          return before === statKey(await chats.stat({ bigint: true }))
        })
      })
    } catch { return false }
    finally { await directory.close() }
  }
}
