import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-tools',
  host: {
    entries: {
      index: 'lib/types/index.js',
      types: 'lib/types/types.js',
      presentation: 'lib/types/presentation.js',
    },
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-code-runtime', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-util-values', '@deepseek-ai/schemastery'],
  },
  client: false,
})
