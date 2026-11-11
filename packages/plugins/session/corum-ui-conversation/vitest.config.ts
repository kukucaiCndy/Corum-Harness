import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
})
