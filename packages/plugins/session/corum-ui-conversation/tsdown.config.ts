/**
 * corum-ui-conversation build: standalone tsdown config mirroring
 * corum-ui-model-selection. The browser bundle is a closure-factory artifact —
 * it calls window.__ModuleLoader__.load({id, factory}) and resolves externals
 * through the loader module table. CSS Modules are compiled by tsdown's own
 * css pipeline and inlined into client.js (scripts/inline-css.mjs folds the
 * extracted sheet into the bundle).
 *
 * External rule (same contract as the official clientBundle preset): the
 * desktop seed module table answers the shell baseline (react, cordis,
 * ui-slots, ui-primitives, client-store) plus every specifier this package
 * declares in dsh.client.external; inline-safe wire layers
 * (dsh-session / dsh-llm / dsh-brand / dsh-util-* / dsh-token-meter/client and
 * generated /remote contributions) are bundled.
 */
import { defineConfig } from 'tsdown'

/** Module-table entries the desktop seed answers: kept external in the browser bundle. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
  // dsh.client.external additions:
  '@deepseek-ai/dsh-api-session-controller/client',
  '@deepseek-ai/dsh-settings',
  // 注：dsh-util-crypto / dsh-util-workspace-path 是普通 util 包（无 dsh.client 声明、
  // 不在模块表），官方是内联打包进 client bundle，**不列 external**（否则运行时
  // 「missed the module table」）。
]

const CLIENT_ID = '@corum/corum-ui-conversation'

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
    // Dual-mode libraries (lexical's exports carry development/production/
    // node conditions; the node file picks its flavor with a top-level await a
    // CJS bundle cannot carry) resolve their static flavor matching the
    // NODE_ENV the defines above bake in — same stance as the official
    // clientBundle preset.
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
