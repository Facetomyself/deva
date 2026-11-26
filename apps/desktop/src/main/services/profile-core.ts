import { Buffer } from 'node:buffer'
import { AUTO_SHAPE, isAvatarShape } from '../../shared/avatar-shape'
import type { UserProfile } from '../../shared/host-settings'

export type { UserProfile } from '../../shared/host-settings'

export const AVATAR_SPEC_MAX = 4096
export const DEFAULT_USER_AVATAR =
  '{"selections":{"head":"hm1-p-000004","body":"hm1-p-000028","bottom":"hm1-p-000037","item":"hm1-p-000062","glasses":"hm1-p-000058"},"colors":{"stroke":"000000","hair":"B0B0B0","skin":"FFE0BD","clothes":"2D2D2D","bottom":"000000"},"background":"0D8CE9"}'

export function projectUserProfile(avatar: unknown, avatarImage: string): UserProfile {
  return { avatar: typeof avatar === 'string' && avatar ? avatar : DEFAULT_USER_AVATAR, avatarImage }
}

const specFields = new Set(['selections', 'colors', 'background', 'shape'])
const partSlots = new Set(['head', 'body', 'bottom', 'item', 'glasses'])
const colorSlots = new Set(['stroke', 'hair', 'skin', 'clothes', 'bottom', 'background'])
// The renderer resolves catalogue ids/aliases; storage admits only inert tokens.
const part = /^[a-z0-9][a-z0-9_-]{0,95}$/i
const color = /^#?(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i
const jsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const matches = (value: unknown, pattern: RegExp): boolean =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value

function specMap(value: unknown, slots: Set<string>, pattern: RegExp): boolean {
  return jsonObject(value) && Object.entries(value).every(([slot, entry]) => slots.has(slot) && matches(entry, pattern))
}

/** Strict Web boundary. Desktop's existing IPC retains its permissive spec setter. */
export function validAvatarSpec(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > AVATAR_SPEC_MAX || Buffer.byteLength(raw) > AVATAR_SPEC_MAX) return false
  if (raw === '') return true
  let spec: unknown
  try { spec = JSON.parse(raw) } catch { return false }
  return jsonObject(spec) && Object.keys(spec).every(key => specFields.has(key)) &&
    (!Object.hasOwn(spec, 'selections') || specMap(spec.selections, partSlots, part)) &&
    (!Object.hasOwn(spec, 'colors') || specMap(spec.colors, colorSlots, color)) &&
    (!Object.hasOwn(spec, 'background') || spec.background === 'transparent' || matches(spec.background, color)) &&
    (!Object.hasOwn(spec, 'shape') || isAvatarShape(spec.shape) || spec.shape === AUTO_SHAPE || spec.shape === 'clover')
}
