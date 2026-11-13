/**
 * 宿主身份段（2026-09-12 用户定调）：把「本会话跑在哪个实例 / home / 端口」作为事实
 * 注入提示词。这里守住三个纯函数的事实口径，防止「角色判错 → 子 Agent 去动用户主实例」
 * 那类事故（起因见 host-identity.ts 的模块注释）。
 */
import { describe, expect, it } from 'vitest'
import { HOST_IDENTITY_SECTION, hostIdentityText, hostInstancePort, hostInstanceRole } from '../src/host-identity.ts'

describe('宿主身份 — 角色 / 端口 / 文本', () => {
  it('验证实例 home 判定为 verify（与 verify-instance.sh 的目录口径一致）', () => {
    expect(hostInstanceRole('/Users/x/work/kkc-desktop/packages/desktop/.corum-verify-home')).toBe('verify')
    expect(hostInstanceRole('/tmp/whatever/.corum-verify3-home')).toBe('verify')
  })

  it('用户 home 与开发 home 都判定为 main', () => {
    expect(hostInstanceRole('/Users/kukucai/.corum')).toBe('main')
    expect(hostInstanceRole('/Users/x/work/kkc-desktop/packages/desktop/.corum-dev-home')).toBe('main')
  })

  it('端口：按角色给默认值，显式配置优先', () => {
    expect(hostInstancePort('verify', undefined)).toBe('9333')
    expect(hostInstancePort('main', undefined)).toBe('9222')
    expect(hostInstancePort('verify', '9355')).toBe('9355')
    expect(hostInstancePort('main', ' 9444 ')).toBe('9444')
  })

  it('文本把 home/端口/角色写成事实，并含两条硬约束（开发类读者 = 全量）', () => {
    const text = hostIdentityText('/Users/x/.corum', undefined, '/Users/x/work/kkc-desktop', { development: true })
    expect(text).toContain('/Users/x/.corum')
    expect(text).toContain('CDP_PORT=9222')
    expect(text).toContain('Instance role: main')
    expect(text).toContain('Working directory: /Users/x/work/kkc-desktop')
    expect(text).toContain('Never restart or kill the instance hosting this session')
    expect(text).toContain('off-limits')
    expect(text).toContain('Other instances may exist')
  })

  it('★ 条件注入：非开发类读者只拿核心事实，CDP 端口与实例规则不注入（2026-11-12 §1.2）', () => {
    const core = hostIdentityText('/Users/x/.corum', undefined, '/Users/x/work/kkc-desktop')
    // 核心事实恒在（role / home / 工作目录 / 不可重启宿主）。
    expect(core).toContain('Instance role: main')
    expect(core).toContain('/Users/x/.corum')
    expect(core).toContain('Working directory: /Users/x/work/kkc-desktop')
    expect(core).toContain('Never restart or kill the instance hosting this session')
    // CDP 面三条不注入。
    expect(core).not.toContain('CDP_PORT')
    expect(core).not.toContain('off-limits')
    expect(core).not.toContain('Other instances may exist')
    // 平台无关：本段是纯文本事实，不含命令/路径拼接字面量。
    expect(core).not.toContain('/bin/')
  })

  it('验证实例的文本明说「宿主在别处可随意重启」，主实例不是', () => {
    const verify = hostIdentityText('/tmp/.corum-verify-home', '9333', undefined, { development: true })
    // 钉住 P1 修复后限定到「宿主在别处」的整句，并排除旧的无条件形态。
    expect(verify).toContain('a session hosted elsewhere (e.g. the main instance) may restart it freely')
    expect(verify).not.toContain('and you may restart it freely')
    expect(verify).not.toContain('the user is using it right now')
    // 回归：普适不变式「不许从内部重启宿主」对 verify 也成立。
    expect(verify).toContain('Never restart or kill the instance hosting this session')
    expect(verify).toContain('would end this session mid-work')
    const main = hostIdentityText('/Users/x/.corum')
    expect(main).toContain('the user is using it right now')
    // main 侧完整 consequence 句逐字存在，且不含 verify 专属的 disposable 措辞。
    expect(main).toContain("- Never restart or kill the instance hosting this session: you cannot see it from the inside, and restarting the main instance destroys the user's work. Ask the user (or let the main Agent decide) instead.")
    expect(main).not.toContain('disposable')
  })

  it('段名稳定（root scope 注册与排障都依赖它）', () => {
    expect(HOST_IDENTITY_SECTION).toBe('corum:host-identity')
  })
})
