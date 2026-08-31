/**
 * corum 运行目录解析（统一 home，废弃 ~/.dsh）。
 *
 * 桌面进程已把 DSH_HOME 指向 CORUM_HOME（见 corum-desktop/host/home.ts），
 * 所以 skill 根 = CORUM_HOME/skills。纯 host bridge 测试时回退 CORUM_HOME。
 * 从 agent-service.ts 拆出（包内文件拆分），供 skill-catalog / agent-service
 * 共享。
 * @module @corum/corum-agent-dev/home
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** corum 运行目录（统一 home 解析，废弃 ~/.dsh）。 */
export function corumHome(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : '~/.corum'
  return resolveDshHome(configured)
}
