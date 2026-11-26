import type { SkillProblem } from './skill-library-transport'

const english = {
  inactive: 'These are saved preferences. Web chat does not run skills or their tools.',
  refresh: 'Refresh', loading: 'Loading skills…', detailLoading: 'Loading skill…', rolesLoading: 'Loading roles…',
  empty: 'No skills yet.', custom: 'Custom', readonly: 'Read-only', savedEnabled: 'Saved enabled preference',
  savedOn: 'Saved: enabled', savedOff: 'Saved: disabled', source: 'Source',
  editRoles: 'Edit available roles', noRoles: 'No roles', oneRole: '1 role', rolesCount: '{n} roles',
  selectedRoles: 'Selected roles', unrecognized: 'Unrecognized role',
  disabledRole: 'Disabled role', saveRoles: 'Save roles', review: 'Review latest', reviewHint: 'Review your choices against the latest saved preferences before saving.',
  emptySelected: 'Choose at least one role or select No roles.', unknownSelected: 'Remove roles that are no longer available before saving.',
  saving: 'Saving preferences…', saved: 'Preferences saved.', sync: 'Live updates paused. Refresh to resume.',
  reconnecting: 'Reconnecting to the skill library…',
  requestedOn: 'Requested preference: enabled.', requestedOff: 'Requested preference: disabled.',
  problem: {
    stale: 'This skill changed elsewhere. Review the latest saved preferences before trying again.',
    missing: 'This skill is no longer available.', readonly: 'This skill is read-only.',
    restricted: 'This preference is restricted.', unknownRole: 'A selected role is no longer available. Review your choices.',
    expired: 'Your session expired.', invalid: 'The skill library returned an invalid response.',
    unavailable: 'The skill library could not confirm the latest information. Refresh to check the saved preferences.'
  } satisfies Record<SkillProblem, string>
}

export const skillCopy: { 'en': typeof english; 'zh-CN': typeof english } = {
  en: english,
  'zh-CN': {
    inactive: '此处仅记录已保存的偏好。Web 对话不会运行技能或技能工具。',
    refresh: '刷新', loading: '正在加载技能…', detailLoading: '正在加载技能详情…', rolesLoading: '正在加载角色…',
    empty: '暂无技能。', custom: '自定义', readonly: '只读', savedEnabled: '保存的启用偏好',
    savedOn: '已保存：启用', savedOff: '已保存：停用', source: '来源',
    editRoles: '编辑可用角色', noRoles: '无可用角色', oneRole: '1 个角色', rolesCount: '{n} 个角色',
    selectedRoles: '指定角色', unrecognized: '未识别的角色',
    disabledRole: '已停用的角色', saveRoles: '保存角色范围', review: '核对最新版本', reviewHint: '保存前请根据最新偏好核对你的选择。',
    emptySelected: '请选择至少一个角色，或选择「无可用角色」。', unknownSelected: '请先移除已失效的角色。',
    saving: '正在保存偏好…', saved: '偏好已保存。', sync: '实时更新已暂停，刷新后继续。',
    reconnecting: '正在重新连接技能库…',
    requestedOn: '所选偏好：启用。', requestedOff: '所选偏好：停用。',
    problem: {
      stale: '此技能已在别处更新。请先核对最新的已保存偏好。',
      missing: '此技能已失效或被移除。', readonly: '此技能为只读。', restricted: '此偏好的修改受限。',
      unknownRole: '所选角色已失效。请核对角色选择。', expired: '会话已过期。',
      invalid: '技能库返回了格式错误的响应。', unavailable: '技能库未能确认最新信息。请刷新后核对已保存偏好。'
    }
  }
}
