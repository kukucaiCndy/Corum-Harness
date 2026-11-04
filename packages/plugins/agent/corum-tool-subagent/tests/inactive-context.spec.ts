/**
 * fork（corum）2026-11-04：**失活上下文下的委派面解析**（实机事故的机器化回归）。
 *
 * ## 事故（会话 `corum-task-18ece7b9`，2026-11-04 15:39）
 *
 * 一次 35 分钟的 `orchestrate`：3 个任务全部 `ok: true`，收尾节点却在派发时立刻失败 ——
 * `closer.error = 'cannot get required service "subagents" in inactive context'`
 * ⇒ 整次编排零报告（各任务正文只喂 closer，拿不到报告 = 结果全丢）。主 Agent 只能事后
 * 逐个 `send_message` 去捞原始报告。
 *
 * ## 根因（与「并行子 Agent 都是前台」无关）
 *
 * `ctx.subagents` 走 cordis 的 `ReflectService.handler.get`：沿 fiber 链找 `fiber.store[prop]`，
 * 一旦碰到 `prop in fiber.inject` 且该 fiber 已失活，直接抛 inactive 错误。本包 `install()`
 * 就装在 `ctx.inject([... 'subagents' ...])` 的临时 fiber 上 —— 用户中途在「设置 → 智能体」
 * 保存了一次 preset（`agent.cordis.yml` mtime 15:39:13），本项目
 * `recomposeLiveSessionsOf` → `disposeStaleStanding` + `recompose` 销毁旧组合的全部 fiber；
 * 5 秒后（15:39:18）closer 派发即撞上失活的闭包 ctx。工具本身仍被注册表持有，所以
 * 「工具照样能调、服务取不到」。
 *
 * ## 为什么本 spec 用**真实 cordis**而不是源码文本断言
 *
 * 这条缺陷的判据是**运行期语义**（哪个解析路径在失活 fiber 上还能用、服务方法的副作用绑在
 * 谁的 fiber 上），源码文本里看不出来。本仓此前的 inactive-context 事故（docs/LESSONS.md
 * §1.13）也是靠实机才定位的。故这里真的 `new Context()`、真的 `inject`、真的 `dispose`。
 *
 * ⚠️ 覆盖边界：本 spec 锁的是**解析路径的正确性**（哪种写法在失活上下文里仍可用）；
 * `install()` 的端到端重挂时序由实机 CDP 验证承担。
 *
 * @module @corum/corum-tool-subagent/tests/inactive-context
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/**
 * 本 spec 的**探针服务面**。
 *
 * 为什么不直接 `ctx.get('subagents')`：那是官方 `SubagentRuntime` 的类型面（没有
 * `read`/`work`），而本 spec 要测的是「解析路径在失活 fiber 上是否可用」这条**一般
 * 语义**——判据与具体服务无关（实测五个注入式服务表现完全同形）。故按红线 3 收窄成
 * 本地能力接口，不耦合任何实现包。
 */
interface ProbeFace {
  read(): string
  work(): Promise<string>
}

/**
 * 取一个探针服务并断言它确实被装配（fail-loud：不让类型断言掩盖装配错误）。
 * @param ctx - 解析起点（失活 ctx 或根 ctx）。
 * @param name - 服务名。
 * @returns 探针能力面。
 * @throws ��服务未注册时。
 */
function probe(ctx: Context, name: 'subagents' | 'llm' | 'jobs'): ProbeFace {
  const service = ctx.get(name, false) as unknown as ProbeFace | undefined
  if (service === undefined) throw new Error(`probe service ${name} is not registered`)
  return service
}

/** 一个最小服务：`read()` 只读；`work()` 会在**自己的 ctx** 上建 effect（模拟 start/投递）。 */
class ProbeService extends Service {
  constructor(ctx: Context, serviceName: string) {
    super(ctx, serviceName)
  }

  read(): string { return 'read-ok' }

  async work(): Promise<string> {
    // 与 `subagents.start()` / `jobs.start()` 同形：副作用绑到接收者自己的 ctx。
    this.ctx.effect(() => () => {}, 'probe.work()')
    return 'work-ok'
  }
}

/**
 * 起一个「已失活」的 install 作用域 ctx：模拟 preset 组合重挂销毁了装工具的那条 fiber。
 *
 * @returns 失活后仍被闭包持有的 runtimeCtx（正是事故里的形态）。
 */
async function disposedInstallCtx(): Promise<{ ctx: Context; root: Context }> {
  const root = new Context()
  new ProbeService(root, 'subagents')
  new ProbeService(root, 'llm')
  new ProbeService(root, 'jobs')

  const holder: { ctx?: Context } = {}
  // 与 install() 同形：装在一个注入式临时 fiber 上。
  const fiber = root.inject(['subagents', 'llm', 'jobs'], (runtimeCtx) => {
    holder.ctx = runtimeCtx
  })
  await fiber
  // 组合重挂 = 该 fiber 被 dispose，而闭包里的 ctx 仍被工具注册表间接持有。
  await fiber.dispose()
  return { ctx: holder.ctx!, root }
}

describe('失活上下文：三条解析路径的真实语义（事故判据）', () => {
  it('★ `ctx.subagents`（代理 getter）在失活 fiber 上直接抛 inactive —— 事故原文', async () => {
    const { ctx } = await disposedInstallCtx()
    // 这就是实机 closer.error 的原文来源。
    expect(() => ctx.subagents).toThrow(/cannot get required service "subagents" in inactive context/)
  })

  it('★ `ctx.get()` 读得到值，但服务方法仍抛 cannot create effect —— 半修不算修', async () => {
    const { ctx } = await disposedInstallCtx()
    // 只读面无碍：这正是「看起来修好了」的陷阱。
    expect(probe(ctx, 'subagents').read()).toBe('read-ok')
    // 副作用面才是真判据：`start()` / `jobs.start()` 都要在自己的 ctx 上建 effect。
    await expect(probe(ctx, 'subagents').work()).rejects.toThrow(/cannot create effect on inactive context/)
  })

  it('★★ `root.get()` 在失活 fiber 上读得到值**且**服务方法可用 —— 唯一正确形态', async () => {
    const { ctx } = await disposedInstallCtx()
    expect(probe(ctx.root, 'subagents').read()).toBe('read-ok')
    await expect(probe(ctx.root, 'subagents').work()).resolves.toBe('work-ok')
  })

  it('同一形态对 llm / jobs 也成立（不是 subagents 的特例）', async () => {
    const { ctx } = await disposedInstallCtx()
    for (const name of ['llm', 'jobs'] as const) {
      expect(() => ctx[name]).toThrow(/inactive context/)
      expect(probe(ctx, name).read()).toBe('read-ok')
      await expect(probe(ctx, name).work()).rejects.toThrow(/cannot create effect on inactive context/)
      await expect(probe(ctx.root, name).work()).resolves.toBe('work-ok')
    }
  })

  it('根 ctx 永远活跃：失活 install 作用域不影响它（修复方向的安全性依据）', async () => {
    const { root } = await disposedInstallCtx()
    await expect(probe(root, 'subagents').work()).resolves.toBe('work-ok')
  })
})

describe('修复落地：派发期一律经 root 解析', () => {
  it('★ `install()` 在入口解析一次 `subagents`，之后派发不再现取 `runtimeCtx.subagents`', () => {
    // 入口解析存在（装配缺失 fail-loud）。
    expect(SRC).toContain('const subagents = resolveDelegationFace(runtimeCtx)')
    // 派发面全部走它 —— 任何 `runtimeCtx.subagents.` 回潮都会让本断言变红。
    const offending = SRC.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /runtimeCtx\.subagents\.|appCtx\.subagents\./.test(line))
      // 注释/文档里引用旧写法是允许的（本仓的 stripComments 纪律）。
      .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    expect(offending.map(o => o.line.trim())).toEqual([])
  })

  it('★ 三条派发路径（integrate / continuable / 前台 / 后台 job）用的都是同一个解析结果', () => {
    for (const call of [
      'const run: SubagentRun = await subagents.start(config.provider',
      'const started = await corumStart(() => subagents.startContinuable({',
      'const start = corumStart(() => subagents.start(config.provider',
      'const startRun = (): Promise<SubagentRun> => corumStart(() => subagents.start(config.provider',
      'if (subagents.getProvider(config.provider) !== subagentProvider) {',
      'const present = subagents.getProvider(config.provider)',
    ]) {
      expect(SRC, `派发路径没有走 root 解析的 subagents：${call}`).toContain(call)
    }
  })

  it('★ `llm` / `jobs` 的派发期读取同样经 root 解析（它们在失活 ctx 上同形失败）', () => {
    expect(SRC).toContain('const jobs = resolveHostService(runtimeCtx, \'jobs\')')
    // install 作用域内的 llm 读取（含 `corumModelCatalog` 的目录列举）全部走 helper。
    // 不锁条数：多一处走 helper 是好事，回潮成直接取才是要红的。
    expect(SRC).toContain('const llm = resolveHostService(runtimeCtx, \'llm\')')
    const rawLlm = SRC.split('\n')
      .filter(line => /runtimeCtx\.get\('llm'\)/.test(line))
      .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
    expect(rawLlm).toEqual([])
  })

  it('★ 装配缺失 fail-loud（不静默降级成「每次派发一个看不懂的错误」）', () => {
    expect(SRC).toContain('the `subagents` service is not provided')
    expect(SRC).toContain('@corum/corum-subagent must be mounted')
  })
})
