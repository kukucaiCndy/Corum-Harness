/**
 * ide-shell build: standalone tsdown config mirroring the corum-desktop /
 * session-archive client bundle. The browser bundle is a closure-factory
 * artifact — it calls window.__ModuleLoader__.load({id, factory}) and resolves
 * externals through the loader module table (react, cordis, and the dsh client
 * platform modules). CSS (module + global) is compiled by tsdown's own css
 * pipeline and inlined into client.js by scripts/inline-css.mjs (the
 * __ModuleLoader__ desktop loader serves no CSS file).
 */
import { defineConfig } from 'tsdown'

/** Module-table entries the desktop seed answers: kept external in the browser bundle. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-theme/client',
]

const CLIENT_ID = '@corum/corum-ide-ui'

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
  // Browser bundle: the ide-shell client half.
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
