/**
 * 基准模式工具面对账（2026-09-12 用户定调：「5 个模式不再直接选中、只作继承模板，
 * 系统内置继承它们的 Agent」）。
 *
 * 本 spec 守住 compile.ts 追加 ⑤ 的三条模式差异——它们逐行对账自官方 preset
 * （packages/desktop/shipped-presets/official/<mode>/agent.cordis.yml）：
 *   ptc     = standard + tool-presentation（mode: ptc）
 *   cordis  = standard + tool-cordis
 *   minimal = persona + tool-bash + filesystem + tool-fs（corum 撤销持久组后）
 *             （官方 minimal 是 bash + str_replace_editor 双工具面；corum 2026-09-11
 *              让 str_replace_editor 退场，等价写面是官方 fs 的 write/edit，故取 tool-fs）
 *   chat    = persona + compaction 组（零执行工具，纯 LLM 对话；2026-11 新增）
 * standard / conductor 仍是全量面（conductor 的裁剪在运行时 tools.restrict）。
 */
import { describe, expect, it } from 'vitest'
import { compilePreset } from '../src/compile.ts'
import type { AgentProfile, BaseMode } from '../src/profile.ts'

function profile(baseMode: BaseMode): AgentProfile {
  return {
    id: `mode-${baseMode}`,
    nickname: '模式探针',
    title: '模式探针',
    dimension: '研发',
    baseMode,
    prompt: 'probe',
    model: { provider: 'localhost', model: 'deepseek-v4-pro' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
}

const ymlOf = (baseMode: BaseMode): string => compilePreset(profile(baseMode)).cordisYml

describe('基准模式工具面 — 继承哪个模式就真的是那个模式的面', () => {
  it('standard：全量面（bash + fs + 检索 + skills + 目标 + 编排 + 网页）', () => {
    const yml = ymlOf('standard')
    for (const id of ['tool-bash', 'filesystem', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'tool-subagent', 'tool-web']) {
      expect(yml).toContain(`id: ${id}`)
    }
    expect(yml).not.toContain('id: tool-presentation')
    expect(yml).not.toContain('id: tool-cordis')
  })

  it('conductor：工具面同 standard（裁剪在运行时，不在编译期）', () => {
    const yml = ymlOf('conductor')
    for (const id of ['tool-bash', 'tool-fs', 'skill-filesystem', 'tool-subagent']) {
      expect(yml).toContain(`id: ${id}`)
    }
  })

  it('ptc：standard + tool-presentation(mode: ptc)', () => {
    const yml = ymlOf('ptc')
    expect(yml).toContain('id: tool-presentation')
    expect(yml).toContain('dsh-agent-tool-presentation')
    expect(yml).toMatch(/mode:\s*"?ptc"?/)
    expect(yml).toContain('id: tool-fs')
  })

  it('cordis：standard + tool-cordis（运行时自省/插件实验）', () => {
    const yml = ymlOf('cordis')
    expect(yml).toContain('id: tool-cordis')
    expect(yml).toContain('dsh-tool-cordis')
    expect(yml).toContain('id: tool-fs')
  })

  it('minimal：只留 persona + tool-bash + filesystem + tool-fs', () => {
    const yml = ymlOf('minimal')
    for (const id of ['persona', 'tool-bash', 'filesystem', 'tool-fs']) {
      expect(yml).toContain(`id: ${id}`)
    }
    // 极简面之外的一律不出现（skills / 子 Agent / 目标 / 计划 / 网页 / 待办 / 后台任务 / MCP）
    for (const id of ['skill-filesystem', 'tool-skill', 'tool-subagent', 'tool-subagent-research', 'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation', 'tool-web', 'tool-todo', 'tool-jobs', 'tool-ask-user', 'tool-fs-search']) {
      expect(yml).not.toContain(`id: ${id}`)
    }
  })

  /**
   * 2026-11 新增：chat 基准模式（纯咨询，零工具）。
   *
   * compile.ts 的 chat 分支仿 minimal 的 splice 裁行先例，但保留集更小——
   * 只留 persona 行 + compaction 组（防长聊爆窗），**零执行工具**
   * （连 bash / filesystem / tool-fs 都裁掉）。
   */
  it('chat：只留 persona + compaction，零执行工具', () => {
    const yml = ymlOf('chat')
    // 应保留：persona + compaction 组
    expect(yml).toContain('id: persona')
    expect(yml).toContain('id: compaction')
    expect(yml).toContain('id: compaction-basic')
    expect(yml).toContain('id: command-compact')
    expect(yml).toContain('id: tool-result-pruner')
    // 一切执行工具 / 能力行都不出现（bash / fs / skills / 子 Agent / 目标 / 计划 / 网页 / 待办 / 后台任务 / MCP / ask-user / present）
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'filesystem', 'skill-filesystem', 'tool-skill', 'tool-subagent', 'tool-subagent-research', 'command-goal', 'tool-goal', 'planning', 'delegation', 'tool-web', 'tool-todo', 'tool-jobs', 'tool-ask-user', 'present', 'tool-presentation', 'tool-cordis']) {
      expect(yml).not.toContain(`id: ${id}`)
    }
  })

  /**
   * 2026-09-14（B 收口轮）：持久 shell 组已撤销，回归一次性 tool-bash。
   *
   * 为什么整条换掉：2026-09-14「效率整改轮」那条回归的前提是「corum 把官方两行
   * splice 成 persistent-shell 组，所以 description 必须自备」——现在持久组整个
   * 不挂了，`config.description` 也无处可传，原断言（`no per-call timeout argument`、
   * `never see EOF here`）**反向**成立了：一次性 tool-bash 恰恰**有** per-call
   * timeoutMs、也**不会**因 stdin 挂住。断言随契约一起翻转，别让它变成一条
   * 「绿着但描述的是已删行为」的假回归。
   *
   * 新契约（由官方 base + standard preset 提供，corum 零覆盖）：
   *   · 不出现 persistent-shell 组、不出现 dsh-tool-bash-persistent；
   *   · tool-bash / tool-pwsh 两行原样保留、平台互斥；
   *   · 不再有 CORUM_PERSISTENT_BASH_DESCRIPTION 那段文本。
   */
  it('shell 工具面：回到官方一次性 tool-bash（无 persistent-shell 组）', () => {
    const yml = ymlOf('standard')
    expect(yml).toContain('id: tool-bash')
    expect(yml).toContain('@deepseek-ai/dsh-tool-bash')
    expect(yml).not.toContain('persistent-shell')
    expect(yml).not.toContain('dsh-tool-bash-persistent')
    expect(yml).not.toContain('dsh-terminal-bash')
    // 撤销后的反例：旧的持久语义文案一个字都不该留在 preset 里
    expect(yml).not.toContain('no per-call timeout argument')
    expect(yml).not.toContain('never see EOF here')
  })
})
