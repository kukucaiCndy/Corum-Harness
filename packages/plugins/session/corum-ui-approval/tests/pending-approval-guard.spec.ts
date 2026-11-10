/**
 * 审批卡的 **composer 选中判据**（`instanceof` → 结构判别）的守卫测试。
 *
 * ## 改的是什么
 *
 * `client/index.ts` 的 `conversation.composer` 链 `select` 原先写
 * `pendingInteraction instanceof PendingApproval`。类身份只在「同一份模块实例」内成立：
 * 打包器把本插件内联成多份 / 宿主再挂一份同包（跨 bundle）时，真审批卡的类来自**另一份**
 * `PendingApproval` ⇒ `instanceof` 为 `false` ⇒ 审批卡静默不渲染（composer 一直空着）。
 *
 * 现改为结构判别 `isPendingApproval(value)`（`contract/slots.ts`），判别字段是**真实
 * 协议字段**：框架 `SessionPendingInteractionBase` 声明了 `readonly kind: string`
 * （"Domain-owned presentation discriminator"），本类实现为 `kind = 'approval'`；
 * 同仓 `PendingQuestion` 用 `'question' | 'plan-review'`。
 *
 * ## 这里钉住什么
 *
 *   ① 同一 realm 的真实实例（含提权卡 `allowsAlwaysAllow: true`）⇒ 选中；
 *   ② 跨 realm / 非同模块类 / 普通同形状对象 ⇒ 仍选中（跨 bundle 的核心诉求）；
 *   ③ 非 approval 域（question / plan-review / 无 kind）⇒ 一律排除，不抢 composer；
 *   ④ 形状像审批但**没有结算方法** ⇒ 排除（否则点按钮时 TypeError）；
 *   ⑤ null / undefined / 原始值 ⇒ 排除，不抛。
 *
 * ⚠️ 这是**防御修复**：它证明选中判据不再依赖类身份，**不等于**旧实机的「审批卡不出现」
 * 已复现/已关闭。
 * @module @corum/corum-ui-approval/tests/pending-approval-guard
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PendingApproval, isPendingApproval } from '../src/client/contract/slots.ts'

type CtorArgs = ConstructorParameters<typeof PendingApproval>

/** 造一张真实审批卡（同一 realm 的本模块实例）。 */
function realApproval(allowsAlwaysAllow = false): PendingApproval {
  return new PendingApproval(
    'session-1' as unknown as CtorArgs[0],
    { toolName: 'bash', reason: '需要写文件' },
    { allowsAlwaysAllow },
  )
}

/** 一个「跨 realm 的同类对象」：类定义来自另一个 vm context（instanceof 必然为 false）。 */
function crossRealmApproval(): unknown {
  return runInNewContext(`(() => {
    class PendingApprovalLike {
      constructor() {
        this.kind = 'approval'
        this.key = 'approval:cross-realm'
        this.sessionId = 'session-1'
        this.toolName = 'bash'
        this.reason = '跨 realm 传来的审批'
        this.allowsAlwaysAllow = false
      }
      answer() { return Promise.resolve() }
      answerAlwaysAllow() { return Promise.resolve() }
    }
    return new PendingApprovalLike()
  })()`)
}

/** 普通同形状对象（另一份 bundle 的对象、或结构化投影出来的数据）。 */
function plainApproval(): Record<string, unknown> {
  return {
    kind: 'approval',
    key: 'approval:plain',
    sessionId: 'session-1',
    toolName: 'bash',
    answer: () => Promise.resolve(),
    answerAlwaysAllow: () => Promise.resolve(),
  }
}

const INDEX = readFileSync(join(import.meta.dirname, '../src/client/index.ts'), 'utf8')

/** 剥掉注释（块注释与行内 `//`），判据只看代码。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const CODE = stripComments(INDEX)

describe('isPendingApproval — 真审批卡必须能被选中', () => {
  it('同一 realm 的真实实例 ⇒ 选中', () => {
    const pending = realApproval()
    expect(isPendingApproval(pending)).toBe(true)
  })

  it('提权卡（allowsAlwaysAllow: true）同样选中', () => {
    expect(isPendingApproval(realApproval(true))).toBe(true)
  })

  it('kind 是真实协议字段（框架 SessionPendingInteractionBase 的领域判别字段）', () => {
    expect(realApproval().kind).toBe('approval')
  })

  it('跨 realm 的同类对象 ⇒ 选中（instanceof 在这一格为 false，正是要修的那格）', () => {
    const foreign = crossRealmApproval()
    expect(foreign instanceof PendingApproval).toBe(false)
    expect(isPendingApproval(foreign)).toBe(true)
  })

  it('普通同形状对象 ⇒ 选中（跨 bundle 的另一份实例形态）', () => {
    expect(isPendingApproval(plainApproval())).toBe(true)
  })
})

describe('isPendingApproval — 非 approval 一律排除，不抢 composer', () => {
  it('别的域（question / plan-review / commit-card）⇒ 排除', () => {
    for (const kind of ['question', 'plan-review', 'commit-card', 'model-ask']) {
      expect(isPendingApproval({ ...plainApproval(), kind }), `kind=${kind}`).toBe(false)
    }
  })

  it('没有 kind 字段的对象 ⇒ 排除', () => {
    const { kind: _kind, ...rest } = plainApproval()
    expect(isPendingApproval(rest)).toBe(false)
  })

  it('形状像审批但没有结算方法 ⇒ 排除（避免点按钮时 TypeError）', () => {
    const noAnswer = { kind: 'approval', key: 'approval:x', sessionId: 's' }
    expect(isPendingApproval(noAnswer)).toBe(false)
    expect(isPendingApproval({ ...noAnswer, answer: () => Promise.resolve() })).toBe(false)
    expect(isPendingApproval({ ...noAnswer, answerAlwaysAllow: () => Promise.resolve() })).toBe(false)
  })

  it('key 不是字符串 ⇒ 排除', () => {
    expect(isPendingApproval({ ...plainApproval(), key: 42 })).toBe(false)
  })

  it('null / undefined / 原始值 / 数组 ⇒ 排除且不抛', () => {
    for (const value of [null, undefined, '', 0, false, 'approval', [], () => {}]) {
      expect(isPendingApproval(value), `value=${String(value)}`).toBe(false)
    }
  })
})

describe('composer select 的源码不变式', () => {
  it('select 用 isPendingApproval 结构判别', () => {
    expect(CODE).toContain('isPendingApproval(pendingInteraction) ? pendingInteraction : null')
  })

  it('select 里没有 instanceof PendingApproval（防回退）', () => {
    expect(CODE).not.toMatch(/instanceof\s+PendingApproval/)
  })
})
