import { ipcMain } from 'electron'
import { join } from 'path'
import { readProfileAvatarImage, writeProfileAvatarImage } from './avatar-image'
import { getConfig, getDevaHome, setConfig } from './config'
import { AVATAR_SPEC_MAX, projectUserProfile, type UserProfile } from './profile-core'

export type { UserProfile } from './profile-core'

/**
 * 本机用户资料（个人资料面板）：目前只有头像。
 * - 生成头像的 spec（AvatarSpec JSON 串，渲染层 humation.tsx 解析）存 `config.json` → `profile.avatar`；
 *   未配置（首次安装）时 getProfile 回 DEFAULT_USER_AVATAR，不写回配置。
 * - 上传的图片在 `<DEVA_HOME>/profile/avatar` 单槽位；兼容原来的 `avatar.<ext>`。
 *   图片以 data URI 交付渲染层，不进 config.json（CSP 不放行 file:）。
 */

function profileDir(): string {
  return join(getDevaHome(), 'profile')
}

function profileSection(): Record<string, unknown> {
  const p = getConfig().profile
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
}

export function getProfile(): UserProfile {
  return projectUserProfile(profileSection().avatar, readProfileAvatarImage(profileDir()))
}

function setProfileAvatar(spec: string): void {
  const avatar = spec.length > AVATAR_SPEC_MAX ? '' : spec
  setConfig({ profile: { ...profileSection(), avatar } })
}

export function registerProfileIpc(): void {
  ipcMain.handle('profile:get', (): UserProfile => getProfile())
  ipcMain.handle('profile:set-avatar', (_e, spec: string): { ok: true } => {
    setProfileAvatar(String(spec ?? ''))
    return { ok: true }
  })
  // 空串 = 清除图片；否则返回读回的 data URI（校验 / 写入失败为空串）。
  ipcMain.handle('profile:set-avatar-image', (_e, dataUri: string): string =>
    writeProfileAvatarImage(profileDir(), String(dataUri ?? ''))
  )
}
