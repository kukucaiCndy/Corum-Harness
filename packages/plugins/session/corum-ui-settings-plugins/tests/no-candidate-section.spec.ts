/**
 * 「子 Agent 候选模型」独立入口**已删除**的回归守卫（用户 2026-11-12 裁定）。
 *
 * 用户原话：「不要再 settings 设计单独的入口，全局放在**智能体设置**中」。于是本包
 * 交出了那张卡、它的 controller 与那条 `settings.section`（id
 * `subagent-model-candidates`），全局候选集搬进 @corum/corum-ide-ui 的
 * `SettingsAgentSettingsSection`（同名设置组）。
 *
 * 为什么要留一个「东西不在了」的 spec：本包此前有 12 条测试全都绕着那张卡/那个 section
 * 转，删干净后这个包就没有任何自有测试了——而「被重新加回去」恰恰是最可能发生的回潮
 * （它的注释里写着「候选集是这个包的功能」）。本文件把**删除本身**钉成断言。
 *
 * @module @corum/corum-ui-settings-plugins/tests/no-candidate-section
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 读本包源码（`tests/` → 包根 → 相对路径）。 */
function readSource(rel: string): string {
  return readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
}

/** 剥掉注释，判「代码还在不在」时只认真代码（注释里允许提到这些名字）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('候选集独立入口已删除（2026-11-12 用户裁定：全局放进「智能体设置」）', () => {
  it('那条 settings.section 不再注册，也没有残留的 id 常量', () => {
    const code = stripComments(readSource('src/client/index.ts'))
    expect(code).not.toContain("'settings.section'")
    expect(code).not.toContain('subagent-model-candidates')
    expect(code).not.toContain('SubagentModelCandidatesSection')
  })

  it('卡片与 controller 已删除（文件层面，不留死代码）', () => {
    for (const file of [
      'src/client/SubagentModelCandidatesSection.tsx',
      'src/client/SubagentModelSelectionCard.tsx',
      'src/client/SubagentModelSelectionCard.module.css',
      'src/client/subagent-model-selection-card-controller.ts',
    ]) {
      expect(existsSync(join(import.meta.dirname, '..', file)), file).toBe(false)
    }
  })

  it('只有那张卡用到的 locale 键已清掉（中文/英文两份都不留）', () => {
    const localeSource = readSource('src/client/locales.ts')
    expect(localeSource).not.toContain('subagentModelSelection')
    expect(localeSource).not.toContain('subagentModelCandidatesNav')
    // 仍然要保留本包真正渲染的那几条（不是把整份字典删了）。
    expect(localeSource).toContain('agentLoopTitle')
    expect(localeSource).toContain('configurableTab')
  })

  it('不再需要 remote 服务（候选集的模型目录已随 controller 搬走）', () => {
    const code = stripComments(readSource('src/client/index.ts'))
    expect(code).toContain("export const inject = ['slots', 'locale', 'configForms']")
    expect(code).not.toContain('ctx.remote')
  })
})