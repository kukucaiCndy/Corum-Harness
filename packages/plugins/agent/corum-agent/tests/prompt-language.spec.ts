/**
 * 提示词语言纪律单测（2026-09-10 用户要求「将提示词都以英文编写」）。
 *
 * 规则：**模型可见提示词一律英文**——系统提示词 / 人格段 / 工具描述 / 工具参数描述 /
 * 注入给 Agent 的消息；UI 文案、错误信息、日志、审计事件摘要保持中文（它们不进模型上下文）。
 *
 * 本 spec 以「源文件扫描」的方式把规则机器化：模型可见位置出现 CJK 即失败。这样任何
 * 后续新增的中文提示词都会被拦下，而不是靠人肉 review。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONDUCTOR_PERSONA } from '../src/conductor.ts'

const SRC = join(import.meta.dirname, '../src')
const CJK = /[\u4e00-\u9fff]/

function source(name: string): string {
  return readFileSync(join(SRC, name), 'utf8')
}

// 项目模式剥离（2026-09-26）：原 `descriptionLiterals()` 抽取器（工具/参数
// `description:` 字面量的 CJK 扫描）只被已移仓的两条断言使用，随之删除；
// 闭源仓 Corum-Harness-Project 若要那两条纪律，需在那里自建等价扫描。

describe('模型可见提示词必须全英文（用户 2026-09-10 定调）', () => {
  it('指挥者人格段（CONDUCTOR_PERSONA）无 CJK，且不得夹带实测调用计数 / 内部日期', () => {
    // 写作纪律（同 prompt-discipline 的 H 组）：提示词只讲规则与判据，实测数字与内部日期属台账/文档，
    // 进提示词会被模型当承诺或依据（2026-09-27 扫出："across eleven calls"、"Observed in practice 2026-09-27"）。
    expect(CONDUCTOR_PERSONA).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
    expect(CONDUCTOR_PERSONA).not.toMatch(/\b(eleven|twelve|thirteen|fourteen|fifteen)\b/)
    expect(CONDUCTOR_PERSONA).not.toMatch(/across \d+ calls/)
    expect(CONDUCTOR_PERSONA).not.toMatch(CJK)
  })

  it('内置角色 persona（PM / 25 岗位 / 指挥者）无 CJK', () => {
    const src = source('builtin-profiles.ts')
    // 只取 BUILTIN_ROLES 区域 + 具名 prompt 常量，避免把昵称/标题（UI 文案）算进来。
    const rolesStart = src.indexOf('const BUILTIN_ROLES')
    const roles = src.slice(rolesStart)
    const promptLiterals = [...roles.matchAll(/prompt:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)].map(m => m[1])
    expect(promptLiterals.length).toBeGreaterThanOrEqual(26)
    for (const literal of promptLiterals) expect(literal, literal).not.toMatch(CJK)

    const pm = src.match(/const PM_PROMPT = \[([\s\S]*?)\]\.join/)
    expect(pm?.[1], 'PM_PROMPT').toBeDefined()
    expect(pm?.[1]).not.toMatch(CJK)
    // 2026-10-11 删：`TASK_PROMPT` 的断言随「Task 助理退役」失效（该常量已在
    // d6611bc「retire Task assistant」里删除，prompt 随角色一起消失），但测试没跟着改
    // ⇒ 本条**长期假红**（实测：不带任何本地改动也失败 `expected undefined to be defined`）。
    // 现在 surviving 的具名 prompt 只有 `PM_PROMPT`（上面已断言）；BUILTIN_ROLES 区域的
    // 全部 prompt 字面量也已在上面的循环里逐个查过 CJK，覆盖没有减少。
  })

  // 项目模式剥离（2026-09-26）：以下三条断言随源文件**移仓**到闭源仓
  // Corum-Harness-Project（`runtime.ts` 的调度器工具描述、`project-data-service.ts`
  // 的数据工具描述、`runtime-task.ts` 的任务消息模板），本仓不再扫描。
  // 那三条纪律在那里仍应生效——闭源仓需自建等价扫描（不在本仓假装还在测）。

  it('工作区 AGENTS.md 模板无 CJK（会被 dsh-agent-instructions 注入每个会话）', () => {
    const src = source('workspace-agents.ts')
    const template = src.slice(src.indexOf('const AGENTS_TEMPLATE'), src.indexOf('`\n\n/**', src.indexOf('const AGENTS_TEMPLATE')))
    expect(template).not.toMatch(CJK)
    expect(template).toContain('workspace instructions')
  })

  it('润色 / 翻译系统提示词无 CJK', () => {
    // 2026-09-20：润色/翻译按关注点抽到 `polish-service.ts`（用户定调「提示词润色这种
    // 其实就可以单独拆出来」）⇒ 断言跟着代码走，扫新模块。
    const src = source('polish-service.ts')
    for (const marker of ['You are a prompt-polishing assistant', 'You are a translation assistant']) {
      expect(src).toContain(marker)
    }
    // 旧中文系统提示词不得回潮。
    expect(src).not.toContain('你是提示词润色助手')
    expect(src).not.toContain('你是翻译助手')
  })

  it('隔离 / 编排机制段与前台 settlement notice 保持英文（回归）', () => {
    const src = source('../../corum-tool-subagent/src/index.ts')
    expect(src).toContain('final report:')
    expect(src).not.toMatch(/description:\s*'[^']*[\u4e00-\u9fff]/)
    // 2026-09-10：隔离通知文本下沉到 @corum/corum-orchestration（工具层 + isolated provider 共用）。
    const orchestrationSrc = source('../../corum-orchestration/src/orchestration.ts')
    expect(orchestrationSrc).toContain('[corum isolation]')
    expect(orchestrationSrc).not.toMatch(/corumIsolationNotice[\s\S]{0,400}[\u4e00-\u9fff]/)
  })
})
