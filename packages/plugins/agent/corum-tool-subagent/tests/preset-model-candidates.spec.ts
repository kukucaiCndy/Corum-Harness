/**
 * issue #165 第二步：**预设自带候选集**的优先级与编译产物。
 *
 * 用户 2026-11 裁定的规则（原话）：
 *
 * > 默认全局候选，如果该 Agent 预设里开启了单独设置，并自己创建了候选集就从 Agent 预设的
 * > 候选集进行选择。
 *
 * 落到代码就是一条三段式优先级：
 *
 *   1. 预设 `childModelCandidates`（`enabled` 且 `models` 非空）⇒ 编进 preset 的
 *      `corum-tool-subagent.config.candidateModels`；
 *   2. 否则全局 `subagent-model-selection` 设置（`enabled`）；
 *   3. 都没有 ⇒ 无候选（`policy === undefined`，机制退回「按 preset 锁定的模型跑」）。
 *
 * 本文件钉两件事：
 * - **编译面**：`compilePreset` 只在「开启且非空」时写 `candidateModels`，tags/note 原样带出；
 * - **运行面**：`selectForAgent` 里预设候选集压过全局设置（源码级不变式 + 纯函数级断言）。
 *
 * 为什么运行面用源码级断言：`selectForAgent` 是 closure，要真跑它得挂起整个 tool 装配
 * （settings 服务 + agents registry + session projections）。本仓既有 `model-policy.spec.ts`
 * 对同一段逻辑也采用源码级判据（`modelSelectionSettings === true` 那条），保持一致；
 * 真正的行为级验证由 CTS 的 C 域用例（C29）与实机承担。
 *
 * @module @corum/corum-tool-subagent/tests/preset-model-candidates
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compilePreset } from '../../corum-agent/src/compile.ts'
import type { AgentProfile } from '../../corum-agent/src/profile.ts'

/** 造一个最小 profile（只带候选集相关字段，其余用默认）。 */
function profileWith(candidates?: AgentProfile['childModelCandidates']): AgentProfile {
  return {
    id: 'candidates-probe',
    nickname: '候选集探针',
    title: '探针',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'probe',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
    ...(candidates === undefined ? {} : { childModelCandidates: candidates }),
  } as never
}

/** 编译产物里 worker / research 两实例的 `candidateModels` 出现次数。 */
function candidateOccurrences(yml: string): number {
  return yml.match(/candidateModels:/g)?.length ?? 0
}

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

describe('编译面：预设候选集只在「开启且非空」时落到 preset', () => {
  it('★ 开启 + 非空 ⇒ 两个子 Agent 实例（worker / research）都带上 candidateModels', () => {
    const yml = compilePreset(profileWith({
      enabled: true,
      models: [
        { provider: 'p-long', model: 'm-long', tags: ['长上下文', '快速'], note: '长文首选' },
        { provider: 'p-vision', model: 'm-vision', tags: ['多模态'] },
      ],
    })).cordisYml
    expect(candidateOccurrences(yml), '两个实例都应带候选集').toBe(2)
    // 渲染形态：`renderConfigLines` 把数组按 JSON 内联（YAML flow 序列，JSON 是其子集），
    // 故断言按它实际写出的样子来 —— 判的是「值原样带出」，不是排版风格。
    expect(yml).toContain('"provider":"p-long"')
    expect(yml).toContain('"长上下文","快速"')
    expect(yml).toContain('"note":"长文首选"')
    expect(yml).toContain('"provider":"p-vision"')
  })

  it('★ 关闭（enabled:false）⇒ 不写 candidateModels（回落全局）', () => {
    const yml = compilePreset(profileWith({
      enabled: false,
      models: [{ provider: 'p', model: 'm' }],
    })).cordisYml
    expect(candidateOccurrences(yml)).toBe(0)
  })

  it('★ 开启但候选为空 ⇒ 不写 candidateModels（空表没有意义，回落全局）', () => {
    const yml = compilePreset(profileWith({ enabled: true, models: [] })).cordisYml
    expect(candidateOccurrences(yml)).toBe(0)
  })

  it('★ 完全没有该字段（老 preset）⇒ 不写 candidateModels', () => {
    const yml = compilePreset(profileWith(undefined)).cordisYml
    expect(candidateOccurrences(yml)).toBe(0)
  })
})

describe('运行面：预设候选集压过全局设置（用户裁定的优先级）', () => {
  it('★ 有预设候选集时先返回它，且不看全局 enabled', () => {
    const block = SRC.slice(
      SRC.indexOf('const presetCandidates ='),
      SRC.indexOf('const selectForAgent ='),
    )
    expect(block).toContain('config.candidateModels')
    expect(block).toContain('.length > 0')

    const selectBlock = SRC.slice(
      SRC.indexOf('const selectForAgent ='),
      SRC.indexOf('const parentId = agent.session.header.origin'),
    )
    // 预设分支必须**排在最前**且直接 return（不再问 settings.current()）。
    const presetReturn = selectBlock.indexOf('if (presetCandidates !== undefined)')
    const settingsRead = selectBlock.indexOf('settings.current()')
    expect(presetReturn, '预设分支必须存在').toBeGreaterThan(-1)
    expect(presetReturn, '预设分支必须排在任何全局设置读取之前').toBeLessThan(settingsRead === -1 ? Number.MAX_SAFE_INTEGER : settingsRead)
    expect(selectBlock).toContain('return { routes: presetCandidates }')
  })

  it('★ 预设候选集为空时，仍走「父会话继承 → 全局 enabled」这条原有链路', () => {
    const selectBlock = SRC.slice(SRC.indexOf('const selectForAgent ='), SRC.indexOf('const parentId = agent.session.header.origin'))
    expect(selectBlock).toContain('subagentModelSelectionPolicy(ctx.sessionProjections, agent.session)')
  })

  it('config 面：candidateModels 用与全局设置同一套 route schema（两套校验会漂）', () => {
    expect(SRC).toContain('candidateModels: z.array(AllowedModelRouteSchema).default([])')
  })
})