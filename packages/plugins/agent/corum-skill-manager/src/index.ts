/**
 * @corum/corum-skill-manager — corum Skill 管理插件。
 *
 * 纯 host 侧插件。SkillManagerService 继承 TypertRemoteService，通过 @Remote
 * 装饰器暴露 /api/skillManager/* 端点供浏览器半（IDE shell）调用。
 *
 * 管理全局 skill 目录（<CORUM_HOME>/skills/）的完整生命周期：
 * 导入（文件 / 文本 / 目录扫描 / 随包内置技能集）、删除、git 版本追踪、版本锁定。
 * @module @corum/corum-skill-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { SkillManagerService } from './skill-manager-service.ts'

export type { SkillInfo, SkillBinding, SkillVersion, SkillVersionsConfig, ImportResult, ScannedSkill, ScanDirectoryResult, ImportDirectoryResult } from './types.ts'
export type { BuiltinSkillImportResult, ShippedImportPlan, ShippedSkill } from './shipped-skills.ts'
export { planShippedImport, resolveShippedSkillsRoot, scanShippedSkills, importShippedSkills } from './shipped-skills.ts'
export { SkillManagerService } from './skill-manager-service.ts'

/** Cordis 插件名。 */
export const name = 'skill-manager'

/** 运行时依赖的服务（空：TypertRemoteService 的构造器自注册到 Gateway，不需要 fiber inject）。 */
export const inject: string[] = []

/** 挂载 SkillManagerService 单例服务。 */
export function apply(ctx: Context): void {
  new SkillManagerService(ctx)
}
