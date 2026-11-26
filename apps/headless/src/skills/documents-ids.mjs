import { BUILTIN_SKILL_CATALOG } from '../../dist/library-core.mjs'

const nativeId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const prototypeNames = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map(k => k.toLowerCase()))
const builtinIds = new Set(BUILTIN_SKILL_CATALOG.map(s => s.id))

export const isPrototypeName = name => prototypeNames.has(name.toLowerCase())
export const isBuiltinAlias = name => builtinIds.has(name.normalize('NFKC').trim().toLowerCase()
  .replace(/^\//u, '').replace(/[\s_.\p{Dash_Punctuation}]+/gu, '-'))

export function isSkillId(id) {
  return typeof id === 'string' && nativeId.exec(id)?.[0] === id && !id.endsWith('.') && !id.includes('..') &&
    !isPrototypeName(id) && (builtinIds.has(id) || !isBuiltinAlias(id))
}
