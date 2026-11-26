// Keep in sync with apps/desktop/src/renderer/src/mock/models.ts.
// A contract test compares this Node mirror with the real renderer source.
const official = (id, name, accent, adapter, apiHost, docUrl, extra) => ({
  id, name, kind: 'official', purpose: 'llm', accent, adapter, apiHost, docUrl,
  enabled: false, models: [], ...extra
})

const seeds = [
  official('anthropic', 'Anthropic', '#d97757', 'anthropic', 'https://api.anthropic.com', 'https://console.anthropic.com/settings/keys'),
  official('openai', 'OpenAI', '#10a37f', 'openai', 'https://api.openai.com/v1', 'https://platform.openai.com/api-keys'),
  official('openai-responses', 'OpenAI · Responses', '#10a37f', 'responses', 'https://api.openai.com/v1', 'https://platform.openai.com/api-keys'),
  official('gemini', 'Google Gemini', '#4285f4', 'openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://aistudio.google.com/apikey'),
  official('deepseek', 'DeepSeek', '#4d6bfe', 'openai', 'https://api.deepseek.com', 'https://platform.deepseek.com/api_keys'),
  official('moonshot', 'Moonshot · Kimi', '#16a085', 'openai', 'https://api.moonshot.cn/v1', 'https://platform.moonshot.cn/console/api-keys'),
  official('zhipu', '智谱 · GLM', '#3859ff', 'openai', 'https://open.bigmodel.cn/api/paas/v4', 'https://bigmodel.cn/usercenter/apikeys'),
  official('qwen', '通义千问 · Qwen', '#615ced', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://bailian.console.aliyun.com/'),
  official('opencode-go', 'OpenCode Go', '#ff6a3d', 'openai', 'https://opencode.ai/inference/go/openai/v1', 'https://opencode.ai/console'),
  official('ollama', 'Ollama · 本地', '#71717a', 'openai', 'http://localhost:11434/v1', 'https://ollama.com/library'),
  official('typesafe', 'TypeSafe · Jev', '#6d5efc', 'jev', 'https://api.typesafe.ai', 'https://console.typesafe.ai', { purpose: 'decision', threshold: 0.6 })
]

export function freshSeeds() {
  return seeds.map(seed => ({ ...seed, models: [] }))
}

export const seedDefaults = new Map(seeds.map(seed => [seed.id, seed]))
