/**
 * corum-ui-approval build: standalone tsdown config mirroring
 * corum-ui-chat / corum-ui-conversation. The browser bundle is a
 * closure-factory artifact — it calls window.__ModuleLoader__.load({id,
 * factory}) and resolves externals through the loader module table. CSS
 * Modules are compiled by tsdown's own css pipeline and inlined into
 * client.js (scripts/inline-css.mjs folds the extracted sheet into the
 * bundle).
 *
 * The fork's conversation layer is the sibling workspace package
 * @corum/corum-ui-conversation: its client half is requested from the module
 * table under that id (the fork bundle registers itself there), so it stays
 * external here instead of being inlined.
 */
import { defineConfig } from 'tsdown'

/** Module-table entries the desktop seed answers: kept external in the browser bundle. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  // The forked conversation layer (module-table row registered by its own bundle):
  '@corum/corum-ui-conversation',
  '@corum/corum-ui-conversation/client',
]

const CLIENT_ID = '@corum/corum-ui-approval'

export default defineConfig(() => [
  // Node library entries (tsc-emitted from lib/types).
  {
    name: CLIENT_ID,
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
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
    entry: { client: 'src/client/index.ts' },
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
