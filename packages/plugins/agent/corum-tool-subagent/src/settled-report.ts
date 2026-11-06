import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
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
