// fork（corum）/ AGENTS 红线 3：类型面一律取本仓 fork（`@corum/corum-subagent`），
// 不 import 官方 `@deepseek-ai/dsh-subagent`——官方包的声明一进本 program，同一套
// `SubagentProvider` 就会有两份模块身份，`subagent/provider-added` 载荷在调用点被推断成
// 联合类型 ⇒ TS2379（capabilities 缺 toolFilter/persona）。实测：只改这一行 import，
// `tsc -b` 从 2 处报错回到 0。
import type { SubagentRunEndInfo } from '@corum/corum-subagent'
import { delegationReportPath, sessionReportDirectory, type SessionReportPersistence } from './session-report-directory.ts'
import { corumWriteReportFile } from './orchestration.ts'

/** 在结算消息之外保存一份完整文档；调用方可安全 fire-and-forget。 */
export async function saveSettledSubagentReport(
  persistence: SessionReportPersistence,
  parentSessionId: string,
  info: SubagentRunEndInfo,
  logger: { warn: (message: string) => void },
): Promise<void> {
  const report = (info.lastAssistantMessage ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (report.trim() === '') return
  try {
    const directory = await sessionReportDirectory(persistence, parentSessionId)
    if (directory === undefined) {
      logger.warn(`subagent report ${info.id}/${info.runId} could not be saved: parent session ${parentSessionId} directory unavailable`)
      return
    }
    const reportPath = delegationReportPath(directory, `${info.id}--${info.runId}`)
    if (!corumWriteReportFile(reportPath, report)) {
      logger.warn(`subagent report ${info.id}/${info.runId} could not be saved to ${reportPath}`)
    }
  } catch (error) {
    logger.warn(`subagent report ${info.id}/${info.runId} for parent session ${parentSessionId} could not be saved: ${String(error)}`)
  }
}
