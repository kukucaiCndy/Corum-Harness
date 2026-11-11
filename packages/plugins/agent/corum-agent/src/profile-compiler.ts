/**
 * fork（corum）：**Profile 编译与落盘**——从 `agent-service.ts` 按关注点抽出（2026-09-20）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在文件
 * 层面切分清晰**，方便维护。」
 *
 * 本模块只回答一个问题：**一个 `AgentProfile` 怎么变成磁盘上的 preset 产物**
 * （`agent.cordis.yml` + `preset.yml` + pinned skill 版本）。它不碰会话、权限、指挥模式、
 * 泳道编排 —— 是「编译与落盘」这一条窄职责。
 *
 * ## 谁在消费
 *
 * - `agent-service` 的 `persistProfileAndRecompile`（保存 profile 的统一收尾）；
 * - 若干路径在 select/mount 之前「先编译落盘再 select」
 *   （`agentPresets.select` 要读 `agent.cordis.yml`；从未编译的 corum profile 若先 select
 *   会抛 `agent-preset/invalid`（composition missing），见 `docs/fork-delta.md` §8 note 3）；
 * - 2026-09-20 的教训：**改 `agent.json` 后必须立刻重新编译落盘**，不能只改 json 就删产物
 *   ——「删掉派生文件等它懒重编译」是错的：官方 discovery 的判据是目录里有 `agent.cordis.yml`，
 *   缺它的目录**不被跳过**而是升成 broken roster row，于是**目录空占 id** ⇒ resume 直接
 *   fail-loud（`docs/LESSONS.md` §4.29，实测导致用户会话无法继续）。
 *
 * @module @corum/corum-agent/profile-compiler
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compilePreset, type CompiledPreset } from './compile.ts'
import { corumHome } from './home.ts'
import type { AgentProfile } from './profile.ts'
import { agentDirPath, listProfiles } from './profile-store.ts'

/** 记日志的最小能力面（避免耦合 cordis 的完整 logger 类型）。 */
export interface ProfileCompilerLogger {
  warn: (message: string, ...rest: readonly unknown[]) => void
}

/**
 * 编译 `AgentProfile` 并落盘到 Agent 目录（写 `agent.cordis.yml` + `preset.yml`）。
 *
 * @param profile - 待编译的 profile（调用方保证已 `saveProfile` 落盘 `agent.json`）。
 * @param dir - 目标目录（通常 `agentDirPath(profile.id)`）。
 */
export function writeAgentDir(profile: AgentProfile, dir: string): void {
  writeCompiledDir(dir, compilePreset(profile))
}

/** 把一份已编译的组合写进 Agent 目录（`agent.cordis.yml` + `preset.yml`）。 */
function writeCompiledDir(dir: string, compiled: CompiledPreset): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
  writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
}

/** 目录里的两份产物是否与 `compiled` 逐字节相同（缺任一份 = 不同）。 */
function compiledDirMatches(dir: string, compiled: CompiledPreset): boolean {
  try {
    if (readFileSync(join(dir, 'agent.cordis.yml'), 'utf8') !== compiled.cordisYml) return false
    if (readFileSync(join(dir, 'preset.yml'), 'utf8') !== compiled.presetYml) return false
    return true
  } catch {
    // ENOENT（从未编译/被删）与读失败一律按「不同」处理：产物是派生数据，重编是安全的。
    return false
  }
}

/**
 * 编译一个 profile 并落盘，**内容相同则不写**（避免每次挂载都触碰 mtime）。
 * @param profile - 待编译的 profile。
 * @param dir - 目标目录。
 * @returns 是否真的写了盘。
 */
export function writeAgentDirIfChanged(profile: AgentProfile, dir: string): boolean {
  const compiled = compilePreset(profile)
  if (compiledDirMatches(dir, compiled)) return false
  writeCompiledDir(dir, compiled)
  return true
}

/** 一次启动期对账的结果（诊断面：谁被重编、谁编不出来）。 */
export interface ReconcileAgentDirsResult {
  /** 实际重写产物的 profile id。 */
  readonly rewritten: readonly string[]
  /** 编译/写盘失败的 `id: 原因`（单个坏 profile 不拖垮其余）。 */
  readonly failed: readonly string[]
  /** 扫到的 profile 总数。 */
  readonly total: number
}

/**
 * **启动期产物对账**：把每个 corum profile 的 `agent.cordis.yml` / `preset.yml`
 * 按**当前编译器**重算，只有内容变了才写盘。
 *
 * 为什么每次启动都要做（AGENTS 红线 8 的「反复出现的残留状态」那一条）：
 * 产物是**派生数据**，而编译器随版本演进。老安装里留着的产物是**上一版编译器**写的，
 * 于是有两层后果，且都不会自己恢复：
 *
 * 1. 产物里的行是**旧 schema**。实测（2026-11 用户报障「切换 Agent 会失败」，
 *    :9333 复现）：升级前的产物仍带 `tool-subagent` 的 `config.backgroundMode`，
 *    而插件的 config schema 已删掉该键 ⇒ 该行构造期直接抛
 *    `agent-preset/invalid: … config.backgroundMode is removed`，整个 preset 挂不上
 *    （连带 `workflow-worker-thread: never started`）。
 * 2. registry 里注册的定义是**启动时读到的旧产物**。界面切换 Agent 时服务会先
 *    重编落盘（{@link writeAgentDirIfChanged}），但 `agentPresets.select/mount` 用的是
 *    registry 里那份 `plugins` 数组，不是刚写的文件 ⇒ 重编**不会**让本次切换生效。
 *    先对账 ⇒ 启动注册读到的就是新产物，两层一起修好。
 *
 * 幂等且便宜：内容没变时每个 profile 只是两次 `readFileSync` + 一次比较。
 *
 * @param logger - 告警出口（单个 profile 失败只 warn，不中断启动）。
 * @returns 对账结果（诊断用）。
 */
export function reconcileAgentDirs(logger: ProfileCompilerLogger): ReconcileAgentDirsResult {
  let profiles: readonly AgentProfile[]
  try {
    profiles = listProfiles()
  } catch (error: unknown) {
    logger.warn(`corum-agent: preset artifact reconcile could not list profiles: ${String(error)}`)
    return { rewritten: [], failed: [], total: 0 }
  }
  const rewritten: string[] = []
  const failed: string[] = []
  for (const profile of profiles) {
    try {
      // 目录已存在 ⇒ 产物缺席 = 旧安装（或产物被删）；一律按「不同」重写。
      if (writeAgentDirIfChanged(profile, agentDirPath(profile.id))) rewritten.push(profile.id)
    } catch (error: unknown) {
      failed.push(`${profile.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failed.length > 0) {
    logger.warn(`corum-agent: preset artifact reconcile failed for ${failed.length} profile(s): ${failed.join('; ')}`)
  }
  return { rewritten, failed, total: profiles.length }
}

/**
 * 把绑定的 skill 切换到 pinned 版本：把 `.versions/<versionId>/SKILL.md` 复制为当前
 * `SKILL.md`。`versionId` 为空 = 用当前 `SKILL.md`（不锁定）。
 *
 * @param logger - 用于告警的能力面。
 * @param profile - 提供 `skills` 绑定列表。
 */
export function checkoutPinnedSkills(logger: ProfileCompilerLogger, profile: AgentProfile): void {
  const skillsRoot = join(corumHome(), 'skills')
  for (const binding of profile.skills) {
    const skillDir = join(skillsRoot, binding.name)
    if (!existsSync(skillDir)) {
      logger.warn(`corum-agent: skill "${binding.name}" not found in ${skillsRoot}`)
      continue
    }
    // 未锁定版本（versionId 空）→ 直接用当前 SKILL.md，跳过切换。
    if (binding.versionId === undefined || binding.versionId === '') continue
    const versionSkillMd = join(skillDir, '.versions', binding.versionId, 'SKILL.md')
    const currentSkillMd = join(skillDir, 'SKILL.md')
    if (!existsSync(versionSkillMd)) {
      // 没有版本目录，说明 skill 是手动放进去的，直接用当前 SKILL.md
      continue
    }
    try {
      const content = readFileSync(versionSkillMd, 'utf8')
      writeFileSync(currentSkillMd, content, 'utf8')
    } catch (error) {
      logger.warn(`corum-agent: failed to switch skill "${binding.name}" to version ${binding.versionId}`, error)
    }
  }
}
