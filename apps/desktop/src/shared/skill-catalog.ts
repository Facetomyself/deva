// Display summaries only. Desktop owns the code-only instructions and runtime metadata.
export const BUILTIN_SKILL_CATALOG = Object.freeze([
  Object.freeze({
    id: 'create-skill',
    name: 'create-skill',
    description:
      '引导用户从零创建一个新技能：从用例规划脚本、参考文档、模板等资源，落盘、校验并启用（单文件调 create_skill，多文件直接写进技能目录）。',
    source: 'builtin' as const
  }),
  Object.freeze({
    id: 'create-agent',
    name: 'create-agent',
    description: '引导用户用对话创建一个新角色：最多问一次厘清用途，随即调 propose_agent 生成名片供确认。',
    source: 'builtin' as const
  }),
  Object.freeze({
    id: 'create-mcp',
    name: 'create-mcp',
    description: '引导用户用对话接入一个 MCP 服务：厘清用途与传输方式、收集要素（密钥仅收字段名）、确认后调 create_mcp 工具落盘并启用。',
    source: 'builtin' as const
  })
] as const)
