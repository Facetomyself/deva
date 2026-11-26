export const copy = {
  'zh-CN': {
    loading: '正在检查会话…',
    claim: '认领实例',
    claimHelp: '使用部署时发放的一次性凭证并设置访问密码。',
    credential: '一次性凭证',
    login: '登录',
    loginHelp: '输入此实例的访问密码。',
    password: '访问密码',
    logout: '退出登录',
    reload: '重新加载',
    settings: '模型设置',
    settingsLoading: '正在加载模型设置…',
    limited: '目前开放模型服务商、密钥及模型清单配置。对话、工作区文件、任务与完整工作台仍在开发中。',
    authFailure: '提交失败。请核对凭证或密码，或重新加载以检查会话。',
    sessionFailure: '会话检查失败。请重新加载。',
    settingsFailure: '模型设置加载失败。请重新加载以读取服务器配置。',
    writeFailure: '页面未能确认服务器上的最终状态。编辑已暂停；请重新加载并检查配置。',
    conflict: '配置已在其他页面或客户端变更。请重新加载以查看最新配置；本页尚未保存的修改未提交。',
    expired: '会话已失效。请重新加载以登录。',
    logoutFailure: '退出登录失败。请重试。'
  },
  en: {
    loading: 'Checking the session…',
    claim: 'Claim instance',
    claimHelp: 'Enter the one-time credential issued during deployment and choose a password.',
    credential: 'One-time credential',
    login: 'Sign in',
    loginHelp: 'Enter this instance’s access password.',
    password: 'Access password',
    logout: 'Sign out',
    reload: 'Reload page',
    settings: 'Model settings',
    settingsLoading: 'Loading model settings…',
    limited: 'Provider, key, and model-list settings are available. Chat, workspace files, tasks, and the full workbench are still in development.',
    authFailure: 'Submission failed. Check the credential or password, or reload to check the session.',
    sessionFailure: 'Could not check the session. Reload to try again.',
    settingsFailure: 'Could not load model settings. Reload to read the server configuration.',
    writeFailure: 'The final state on the server could not be confirmed. Editing is paused. Reload and check the settings.',
    conflict: 'Settings changed on another page or client. Reload for the latest settings; pending edits were not saved.',
    expired: 'The session has expired. Reload to sign in.',
    logoutFailure: 'Could not sign out. Try again.'
  }
}

export type Locale = keyof typeof copy
export type Issue = 'authFailure' | 'sessionFailure' | 'settingsFailure' | 'writeFailure' | 'conflict' | 'expired'
