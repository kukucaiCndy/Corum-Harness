import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-mcp-manager',
  host: {
    entries: ['lib/types/index.js', 'lib/types/proxy.js'],
    external: ['@corum/corum-extension-registry', '@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-home-paths', '@modelcontextprotocol/sdk'],
  },
  client: false,
})
