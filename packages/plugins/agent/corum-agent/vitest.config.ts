/**
 * @corum/corum-agent test config.
 *
 * `src/project-data-service.ts` carries standard TypeScript decorators
 * (`@Remote('listRequirements')` …) that Vite's default esbuild parser rejects
 * with "Invalid or unexpected token" before Vitest can load the source-mode
 * imports. Mirrors the corum-subagent `standardDecoratorPlugin` pre-transform
 * (itself mirroring the official dsh `standardDecoratorPlugin`): transpile
 * `.ts` files containing decorator syntax with the TypeScript compiler before
 * Vite parses them.
 *
 * 2026-10-11：**刻意不加** `@corum/corum-preset-modules` 的 resolve.alias。
 * 曾经加过（指向它的 `src/index.ts`），随后实机报
 * `does not provide an export named 'mergeModuleRequires'`——测试全绿而运行时崩，
 * 因为运行时解析的是**打包产物** `lib/index.js`，而 alias 让测试看源码。
 * 判据：凡测试替身改变了"被加载的产物"，它就在测试另一套东西。
 * 正确姿势是改完 preset-modules 先 `pnpm --filter @corum/corum-preset-modules run build`。
 */
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/** Pre-transform standard TypeScript decorators before Vite's parser sees the source. */
function standardDecoratorPlugin() {
  return {
    name: 'corum-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
