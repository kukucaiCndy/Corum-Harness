/**
 * @corum/corum-session-query-sqlite build: host-only fork of the official SQLite
 * session-query backend. tsc emits `lib/types/**.js`; tsdown bundles the entry
 * into `lib/index.js` with runtime-installed @deepseek-ai/* packages kept as
 * imports (they are on disk at runtime inside the host closure).
 */
import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@corum/corum-session-query-sqlite'

/** Host-half production dependencies: on disk at runtime, stay imports. */
const HOST_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/schemastery',
]

export default defineConfig(() => [
  {
    name: PACKAGE_ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier: string) =>
        HOST_EXTERNALS.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
      alwaysBundle: (specifier: string) =>
        !HOST_EXTERNALS.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
    },
  },
])
