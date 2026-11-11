import path from 'node:path'

/** JSONL 持久层公开的定位能力；不从 CORUM_HOME 猜测配置或项目目录。 */
export interface SessionReportPersistence {
  resolveCurrentLog(id: string): Promise<string | undefined>
  flush(): Promise<void>
}

/** 报告归属于父会话，随同会话目录迁移和删除。 */
export async function sessionReportDirectory(persistence: SessionReportPersistence, sessionId: string): Promise<string | undefined> {
  try {
    let logPath = await persistence.resolveCurrentLog(sessionId)
    if (logPath === undefined) {
      await persistence.flush()
      logPath = await persistence.resolveCurrentLog(sessionId)
    }
    return logPath !== undefined && path.isAbsolute(logPath) ? path.dirname(logPath) : undefined
  } catch {
    // 定位失败只能影响报告保存，不能吞掉已经完成的子任务结果。
    return undefined
  }
}

/** 子会话 id 编码成单个路径段，保留每次委派返回的完整文档。 */
export function delegationReportPath(directory: string, childSessionId: string): string {
  return path.join(directory, 'subagent-reports', `${encodeURIComponent(childSessionId)}.md`)
}
