/**
 * @corum/corum-tools test config.
 *
 * ## 为什么有这一份
 *
 * 这套测试是从官方 `dsh-tools` **版本匹配**地搬过来的（tag `dsh-v0.1.5-rc.3`，见
 * `tests/README.md`）。官方是在**仓库根**的 `vitest.config.ts` 下跑它们，且那份配置用
 * `vite-tsconfig-paths` 把包名映射到**源码**；本仓没有根配置，所以在每个包自己的配置里把
 * 「测试文件在哪」与「这几个 import 说明符怎么解析」显式写清。
 *
 * ## 为什么要给 `@deepseek-ai/dsh-tools` 加 alias（**这不是**corum-agent 那条坑的重复）
 *
 * 本包是官方 `@deepseek-ai/dsh-tools` 的**整包 fork**，根 `pnpm-workspace.yaml` 用
 * `'@deepseek-ai/dsh-tools': 'link:packages/plugins/agent/corum-tools'` 让**别的包**解析到本包
 * （实测：`corum-tool-subagent/node_modules/@deepseek-ai/dsh-tools -> ../../../corum-tools` ✓）。
 * 但**本包自己**无法用包名解析自己：pnpm 不会给包建自引用链接，向上找只会落到
 * `node_modules/.pnpm/node_modules/@deepseek-ai/dsh-tools`（那是**官方 registry 版**，
 * 不是本 fork）⇒ 实测 9/11 个 spec 直接 `Cannot find package '@deepseek-ai/dsh-tools'`。
 *
 * ## alias 指向 **lib**，不是 src（这一点是实测踩出来的，别改回去）
 *
 * 第一版把裸包名指向本包**源码** `src/index.ts`，结果 25 条测试失败——不是版本错配，
 * 而是**模块实例被切成两份**：spec 里 `import … from '@deepseek-ai/dsh-tools'` 走 alias 拿到
 * 源码副本，而那些官方依赖（`dsh-agent-loop` 等，在 `.pnpm` 里）解析 `@deepseek-ai/dsh-tools`
 * 拿到的是**本 fork 的打包产物** `lib/index.js`
 * （实测：`.pnpm/@deepseek-ai+dsh-agent-loop@0.1.5-rc.3…/node_modules/@deepseek-ai/dsh-tools`
 * → `packages/plugins/agent/corum-tools`，即 override 生效了）。
 * 于是「注册表/符号/服务单例」这类身份敏感的断言在两份实例之间对不上。
 *
 * ⇒ 裸包名与 `/invariant` 一律指向 **lib**（消费方真正加载的那一份，也正是本仓那条
 * 「别让测试看源码、运行期看产物」纪律要求的对象）；只有官方 spec 显式写死的
 * `/src/*.ts`（3 处，纯函数对比测试）仍走源码——那是**包 exports 里本就存在的路径**
 * （`"./src/*": "./src/*"`），官方语义如此。
 *
 * 推论（写进纪律）：**改完本包必须先 `pnpm --filter @corum/corum-tools run build` 再跑测试**，
 * 否则测试跑的是上一次的产物。仓库门禁的顺序是 typecheck → test → build，所以本地单跑测试时
 * 记得先 build。
 *
 * **刻意不加装饰器预转译插件**（对照 `corum-agent/vitest.config.ts` 那份）：官方 tools 源码
 * 一行装饰器都没有（已核：`grep -nE "^[[:space:]]*@[A-Za-z_$]" src/*.ts` 为空），
 * cordis 4 的服务靠 `Service` 基类而非装饰器。加了就是无用配置。
 *
 * ## alias 清单是**穷举**的，不是通配
 *
 * 搬来的 11 个 spec 只用到这 4 种说明符（实测 `grep -rhoE "from '@deepseek-ai/dsh-tools[^']*'"`）：
 * 裸包名 ×13、`/src/ts-types.ts` ×3、`/src/py-types.ts` ×1、`/src/json-schema.ts` ×1、`/invariant` ×1。
 * 刻意**不写通配正则**——通配会把将来新增的官方子路径也静默接到本包源码上，
 * 而那种地方恰恰需要人当场判断「这个子路径本 fork 有没有对应文件」。
 * 新增 spec 若用到别的子路径，这里会以「无法解析」的形态**当场报错**，正是想要的行为。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * alias 目标解析（相对本配置的 URL，worktree/绝对路径都成立）。
 * @param dir - `lib`（打包产物，身份一致的默认目标）或 `src`（仅官方 spec 显式写死的 `/src/*`）。
 * @param file - 目标文件名。
 */
const at = (dir: 'lib' | 'src', file: string): string => fileURLToPath(new URL(`./${dir}/${file}`, import.meta.url))
const lib = (file: string): string => at('lib', file)
const src = (file: string): string => at('src', file)

export default defineConfig({
  resolve: {
    alias: [
      // 裸包名 ⇒ **打包产物**（与其它包/官方依赖拿到的是同一份实例；见文件头）。
      { find: /^@deepseek-ai\/dsh-tools$/, replacement: lib('index.js') },
      // `@deepseek-ai/dsh-tools/invariant` ⇒ 产物里的 invariant 入口（同样为实例一致）。
      { find: /^@deepseek-ai\/dsh-tools\/invariant$/, replacement: lib('invariant.js') },
      // 官方 spec 直接 import 源文件（带 .ts 后缀）的几个：逐条列出，不做通配。
      { find: /^@deepseek-ai\/dsh-tools\/src\/ts-types\.ts$/, replacement: src('ts-types.ts') },
      { find: /^@deepseek-ai\/dsh-tools\/src\/json-schema\.ts$/, replacement: src('json-schema.ts') },
      { find: /^@deepseek-ai\/dsh-tools\/src\/py-types\.ts$/, replacement: src('py-types.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
