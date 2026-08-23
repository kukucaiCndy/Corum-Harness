/**
 * @corum/corum-skill-manager-ui-dev — corum Skill Manager UI 壳。
 *
 * 基于 shell-base 的独立 Skill 管理 UI 壳，可在 dev-agent combo 和
 * 未来 IDE 模式复用。注册一个 root 槽，填充 SkillManagerPanel 组件
 * 让用户通过桌面 IPC 桥调 /api/skillManager/* 端点管理 skill：
 *   - listAll：列出所有已安装 skill
 *   - importFromFile / importFromText：导入 skill
 *   - delete：删除 skill
 *   - getSkillHistory：查看 git 版本历史
 *   - pinVersion：锁定版本
 *
 * 纯浏览器侧插件（host 半 no-op）。
 * @module @corum/corum-skill-manager-ui-dev
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件名。 */
export const name = 'dev-skill-manager-shell'

/** 运行时依赖的服务（空：纯 UI 插件，所有能力经 RPC 桥调用）。 */
export const inject: string[] = []

/** Host 半 no-op（所有逻辑在 client 半）。 */
export function apply(_ctx: Context): void {
  // The dev-skill-manager-shell contributions are browser-only.
}
