import type { Locale } from './first-use-copy'
import { HttpFailure } from './transport'

const labels = {
  'zh-CN': {
    loading: '正在读取服务器数据…', readFailure: '读取失败，请重新读取。',
    stale: '此处数据已变更或保存结果未确认。重新读取后检查最新内容；当前草稿会丢弃，编辑不会自动重试。',
    reload: '重新读取', busy: '正在保存…', saved: '已保存',
    rejected: '服务器未保存这次操作，请检查输入后重试。', unavailable: '工作区已不可用，请重新选择。',
    protected: '默认角色受保护', referenced: '此角色仍被引用，无法删除。', limit: '角色数量已达上限。',
    addMemory: '新增记忆', memoryType: '记忆类型', types: { user: '用户', feedback: '做事方式', project: '项目进展', reference: '参考资料' },
    memoryManual: '纯文本对话不会写入记忆。可在此手动新增或修改条目。',
    projectMemory: '项目记忆', roleMemory: '角色记忆', workspace: '工作区', selectWorkspace: '选择已获准的工作区',
    noWorkspace: '暂无已获准的工作区。', defaultWorkspace: '默认工作区',
    roles: '角色花名册', newRole: '新建角色', noRoles: '还没有角色。', pickRole: '选择一个角色查看详情。',
    enabled: '已启用', disabled: '已停用', enable: '启用', disable: '停用',
    up: '上移', down: '下移', deleteRole: '删除角色', confirmDelete: '删除“{name}”？只有未被引用的角色可删除。',
    roleScope: '已启用的角色可发起纯文本对话。网页暂未开放技能、带工具的对话、通过对话创建角色。',
    startFailure: '未能开始角色对话。请重新读取花名册，确认该角色仍已启用。',
    missingModel: '原模型引用', missingWorkspace: '原工作区已不可用',
    editAvatar: '编辑角色头像', editGeneratedAvatar: '编辑生成头像', portraitPartial: '角色资料已保存；头像的保存状态未确认。请重新读取以检查头像。', inputTooLong: '输入超出长度上限。'
  },
  en: {
    loading: 'Reading from the server…', readFailure: 'Could not read the server data. Reload this panel to try again.',
    stale: 'This data changed or the save could not be confirmed. Reload to check the latest values. The current draft will be discarded, and no edit will be retried automatically.',
    reload: 'Reload panel', busy: 'Saving…', saved: 'Saved',
    rejected: 'The server did not save this operation. Check your input and try again.', unavailable: 'This workspace is no longer available. Choose another workspace.',
    protected: 'Protected default role', referenced: 'This role is still referenced and cannot be deleted.', limit: 'The role limit has been reached.',
    addMemory: 'Add memory', memoryType: 'Memory type', types: { user: 'User', feedback: 'Working preferences', project: 'Project progress', reference: 'Reference' },
    memoryManual: 'Text-only chat does not write memories. Add or edit entries here.',
    projectMemory: 'Project memory', roleMemory: 'Role memory', workspace: 'Workspace', selectWorkspace: 'Select an approved workspace',
    noWorkspace: 'There are no approved workspaces.', defaultWorkspace: 'Default workspace',
    roles: 'Role roster', newRole: 'New role', noRoles: 'No roles yet.', pickRole: 'Select a role to view its details.',
    enabled: 'Enabled', disabled: 'Disabled', enable: 'Enable', disable: 'Disable',
    up: 'Move up', down: 'Move down', deleteRole: 'Delete role', confirmDelete: 'Delete “{name}”? Only roles without references can be deleted.',
    roleScope: 'Enabled roles can start text-only conversations. Skills, tool-enabled chat, role creation through chat are not available here.',
    startFailure: 'Could not start this conversation. Reload the roster and verify the role is still enabled.',
    missingModel: 'Existing model reference', missingWorkspace: 'Existing workspace unavailable',
    editAvatar: 'Edit role avatar', editGeneratedAvatar: 'Edit generated avatar', portraitPartial: 'The role details were saved but the picture could not be confirmed. Reload to check the picture.', inputTooLong: 'Input is too long.'
  }
}

export const libraryCopy = (locale: Locale) => labels[locale]
export type LibraryIssue = 'readFailure' | 'stale' | 'rejected' | 'unavailable' | 'protected' | 'referenced' | 'limit'

export function libraryIssue(error: unknown, write: boolean): LibraryIssue {
  if (error instanceof HttpFailure) {
    const code = error.code?.toLowerCase()
    if (code === 'role_referenced') return 'referenced'
    if (code === 'role_protected') return 'protected'
    if (code === 'role_limit') return 'limit'
    if (code === 'workspace_unavailable') return 'unavailable'
    if (error.status === 409 || (write && error.status === 404)) return 'stale'
    if (write && error.status < 500 && ![401, 403].includes(error.status)) return 'rejected'
  }
  return write ? 'stale' : 'readFailure'
}
