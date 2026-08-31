/**
 * corum-ui-questions build: standalone tsdown config mirroring
 * corum-ui-chat / corum-ui-conversation / corum-ui-model-selection. The browser
 * bundle is a closure-factory artifact — it calls window.__ModuleLoader__.load({id,
 * factory}) and resolves externals through the loader module table. CSS
 * Modules are compiled by tsdown's own css pipeline and inlined into
 * client.js (scripts/inline-css.mjs folds the extracted sheet into the
 * bundle).
 *
 * Unlike corum-ui-chat, this plugin does NOT depend on the conversation layer
 * (@corum/corum-ui-conversation). It only needs session-level packages.
 */
import { defineConfig } from 'tsdown'

/** Module-table entries the desktop seed answers: kept external in the browser bundle. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
  // dsh.client.external additions:
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-api-session-controller/client',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-user-questions',
]

const CLIENT_ID = '@corum/corum-ui-questions'

export default defineConfig(() => [
  // Node library entries (tsc-emitted from lib/types).
  {
    name: CLIENT_ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  // Browser bundle: the fork's client half.
  {
    name: `${CLIENT_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // Same dual-mode condition pinning as the official clientBundle preset
    // (lexical & co resolve their static production/browser flavor).
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    css: { splitting: false },
    outputOptions: {
      entryFileNames: 'client.js',
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
