/**
 * Type shims for monaco-editor's ESM subpaths.
 *
 * The package `exports` maps `"./*"` to `./esm/vs/*.js` WITHOUT a `types`
 * condition, so TypeScript cannot resolve `monaco-editor/esm/vs/editor/editor.api`
 * or the language `monaco.contribution.js` side-effect imports on its own. This
 * file declares those subpaths against their real `.d.ts`/`.js` siblings so the
 * client bundle imports type-check while the bundler resolves the same
 * specifiers at build time. The shims stay type-only: nothing here survives to
 * runtime.
 * @module corum-shell/client/editor/monaco-modules
 */

declare module 'monaco-editor/editor/editor.api' {
  import type * as Monaco from 'monaco-editor'
  export const editor: typeof Monaco.editor
  export const languages: typeof Monaco.languages
  export const worker: typeof Monaco.worker
  export * from 'monaco-editor'
}

declare module 'monaco-editor/language/typescript/monaco.contribution.js' {}
declare module 'monaco-editor/language/json/monaco.contribution.js' {}
declare module 'monaco-editor/language/css/monaco.contribution.js' {}
declare module 'monaco-editor/language/html/monaco.contribution.js' {}
