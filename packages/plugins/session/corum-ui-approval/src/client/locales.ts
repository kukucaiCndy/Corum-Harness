/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
  allowOptions: '允许方式',
  allowSession: '本会话始终允许',
  allowSessionRequest: '仅相同工具和审批原因，断开连接后失效',
  allowSessionEscalation: '本会话内相同提权档位免问',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  allowOptions: 'Approval options',
  allowSession: 'Always allow in this session',
  allowSessionRequest: 'Same tool and reason only; cleared on disconnect',
  allowSessionEscalation: 'Same escalation mode in this session',
} satisfies Record<ApprovalKey, string>
