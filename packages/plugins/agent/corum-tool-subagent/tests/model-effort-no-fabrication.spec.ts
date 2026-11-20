/**
 * 2026-11 实机事故的回归网：**机制不得凭空补思考档** + 面板思考档能力的 host 半。
 *
 * ## 事故现场（会话 `corum-task-e8da89ad`「评审并完成分栏会话功能」）
 *
 * 预设锁面配了 `localhost/glm-5.2`（**未配思考档**），机制在装配锁定路由时凭空补了
 * `reasoningEffort: 'high'` ⇒ `llm.resolveCallConfig` 拒绝（该模型不支持 high）⇒
 * **健康模型被误判「模型不可用」**，每次委派都弹面板；用户选了「再试一次」能救回本次
 * （重试路由不带 effort），但下一次新委派又补 'high'、又失败 —— 用户看到的正是
 * 「选了处理也照样失败」。广播帧（corumSpawnModel）也同源补 'high'，卡片显示一个
 * 请求里根本不存在的档位。
 *
 * ## 断言什么
 *
 * ① 请求级与广播帧都**不得**出现 `reasoningEffort: 'high'` 的凭空注入（源码守卫，
 *    剥注释判 —— 注释里正当地记着事故原文）；
 * ② 「临时用主模型」的回退路由**含主 Agent 的思考档**（完全一致的承诺）；
 * ③ 模型清单附带推理档位元数据（`resolveModelInfo` 接线），供面板思考档选择；
 * ④ temporary 档文案不再承诺「可选指定模型」（2026-11 用户裁定：一步应用）。
 *
 * ②③ 用真询问核驱动（只把通路/清单换桩），① 用源码守卫（装配点在 spawnOne 内部，
 * 无法不起宿主单测；本仓 model-policy.spec 同款手法）。
 *
 * @module @corum/corum-tool-subagent/tests/model-effort-no-fabrication
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CorumOrchestration } from '../src/index.ts'
import {
  corumAskAboutModelUnlessStale,
  corumDelegationPolicyStateFrom,
  corumResetModelAskLocks,
  type CorumCatalogModel,
  type CorumModelAskOutcome,
} from '../src/model-ask-run.ts'
import { corumModelAskOptions, corumResolveModelAskDecision } from '../src/model-ask.ts'

afterEach(() => {
  corumResetModelAskLocks()
})

const INDEX = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/** 剥注释（事故原文正当地记在注释里，裸子串判会把说明也算成违规）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('① 不得凭空补思考档（事故真因）', () => {
  it('★★ 源码里不存在 reasoningEffort: \'high\' 的凭空注入（请求级 + 广播帧共 5 处曾违规）', () => {
    const code = stripComments(INDEX)
    // 负向控制：修复前本条必红（锁定路由 1 处 + 广播帧 4 处）。
    expect(code).not.toContain("reasoningEffort: 'high'")
    expect(code).not.toContain('reasoningEffort: "high"')
  })

  it('★ 锁定路由的 effort 只在锁面确有值时带上（省略 = 适配器默认档）', () => {
    const code = stripComments(INDEX)
    const at = code.indexOf('const corumLockedOptions')
    expect(at, '找不到 corumLockedOptions 装配点').toBeGreaterThan(-1)
    const block = code.slice(at, code.indexOf('const maxDepth', at))
    expect(block).toContain('corumEffectiveModel.reasoningEffort !== undefined')
    // 缺省分支必须是空对象（省略），不是任何具体档位。
    expect(block).toMatch(/:\s*\{\}\s*\),/)
  })

  it('★ 回退路由（facts.fallback）带上主 Agent 的思考档', () => {
    const code = stripComments(INDEX)
    expect(code).toContain('parentOptions.reasoningEffort !== undefined ? { reasoningEffort: parentOptions.reasoningEffort }')
  })
})

describe('② 临时档 = 与主 Agent 完全一致（含思考档）', () => {
  const PARENT_WITH_EFFORT = { provider: 'p-main', model: 'm-main', reasoningEffort: 'max' }

  it('★ 纯判定：temporary 未指定模型 ⇒ 回退路由原样（effort 不丢）', () => {
    expect(corumResolveModelAskDecision('temporary', PARENT_WITH_EFFORT, undefined))
      .toEqual({ kind: 'temporary', route: PARENT_WITH_EFFORT })
  })

  it('★ 主 Agent 没有思考档 ⇒ 回退路由也不带（不凭空补）', () => {
    const decision = corumResolveModelAskDecision('temporary', { provider: 'p', model: 'm' }, undefined)
    expect(decision.kind).toBe('temporary')
    expect(Object.keys((decision as { route: object }).route)).not.toContain('reasoningEffort')
  })

  it('★ 真链路：temporary 的 override 含主 Agent 思考档，且不写任何状态', async () => {
    const svc = new CorumOrchestration(new Context())
    const outcome: CorumModelAskOutcome = await corumAskAboutModelUnlessStale(
      {
        state: corumDelegationPolicyStateFrom(svc),
        channel: { call: async () => ({ kind: 'temporary' }) as never },
        catalog: { listRoutes: async () => [] },
      },
      { session: { id: 'sess-effort' }, ctx: {} } as unknown as Agent,
      {
        label: '思考档回归',
        role: 'worker',
        configured: { provider: 'p-bad', model: 'm-bad' },
        fallback: { ...PARENT_WITH_EFFORT },
        cause: 'rate limited (429)',
      },
      new AbortController().signal,
      { warn: () => {}, info: () => {} },
    )
    expect(outcome.override).toEqual(PARENT_WITH_EFFORT)
    expect(svc.modelOverrideOf('sess-effort', 'worker')).toBeUndefined()
  })
})

describe('③ 模型清单附带推理档位元数据（面板思考档选择的数据源）', () => {
  it('★ 接线存在：catalog 走 resolveModelInfo 取 reasoning（listModels 不含它）', () => {
    const code = stripComments(INDEX)
    const at = code.indexOf('function corumModelCatalog')
    expect(at, '找不到 corumModelCatalog').toBeGreaterThan(-1)
    const block = code.slice(at, code.indexOf('function corumModelAskChannel', at))
    expect(block).toContain('resolveModelInfo')
    expect(block).toContain('reasoning')
  })

  it('★ 真链路：清单里的 reasoning 原样下发给面板（host 不裁剪）', async () => {
    const models: CorumCatalogModel[] = [{
      model: 'm-main',
      label: 'Main',
      reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'max', name: 'max' }], defaultEffort: 'low' },
    }]
    let seen: unknown
    const svc = new CorumOrchestration(new Context())
    await corumAskAboutModelUnlessStale(
      {
        state: corumDelegationPolicyStateFrom(svc),
        channel: {
          call: async (request: unknown) => {
            seen = request
            return { kind: 'cancel' } as never
          },
        },
        catalog: { listRoutes: async () => [{ provider: 'p-main', label: 'Main', models }] },
      },
      { session: { id: 'sess-catalog' }, ctx: {} } as unknown as Agent,
      {
        label: '清单回归',
        role: 'worker',
        configured: { provider: 'p-bad', model: 'm-bad' },
        fallback: { provider: 'p-main', model: 'm-main' },
        cause: 'boom',
      },
      new AbortController().signal,
      { warn: () => {}, info: () => {} },
    )
    expect((seen as { catalog: unknown }).catalog).toEqual([{ provider: 'p-main', label: 'Main', models }])
  })

  it('★ permanent-route 带思考档 ⇒ 原样写预设 / 覆盖（effort 不被丢）', async () => {
    const svc = new CorumOrchestration(new Context())
    const writes: unknown[] = []
    const route = { provider: 'p-main', model: 'm-main', reasoningEffort: 'max' }
    const outcome = await corumAskAboutModelUnlessStale(
      {
        state: corumDelegationPolicyStateFrom(svc),
        channel: { call: async () => ({ kind: 'permanent-route', route }) as never },
        profile: {
          applySubagentModelForSession: (_sessionId: string, _role: 'worker' | 'research', r: unknown) => {
            writes.push(r)
            return { presetId: 'preset-x', applied: r as never }
          },
        },
        catalog: { listRoutes: async () => [] },
      },
      { session: { id: 'sess-perm' }, ctx: {} } as unknown as Agent,
      {
        label: '永久档回归',
        role: 'worker',
        configured: { provider: 'p-bad', model: 'm-bad' },
        fallback: { provider: 'p-main', model: 'm-main' },
        cause: 'boom',
      },
      new AbortController().signal,
      { warn: () => {}, info: () => {} },
    )
    expect(writes).toEqual([route])
    expect(svc.modelOverrideOf('sess-perm', 'worker')).toEqual(route)
    expect(outcome.override).toEqual(route)
  })
})

describe('④ temporary 档文案（2026-11 用户裁定）', () => {
  it('★ 不再承诺「可选指定模型」，改为「与主 Agent 完全一致（含思考档）」', () => {
    const temporary = corumModelAskOptions().find(option => option.kind === 'temporary')
    expect(temporary).toBeDefined()
    expect(temporary?.description).not.toContain('可选指定模型')
    expect(temporary?.description).toContain('思考档')
  })
})