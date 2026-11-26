/**
 * AclElevationDialog —— Windows 工作区 ACL 提权修复引导卡。
 *
 * 监听 `corum/acl/elevation-required` 事件后由 AppFrame 渲染：
 *   - 第一态：标题「工作区权限不足」+ 路径 + 「一键修复」按钮 → 调
 *     `platform/fixWorkspaceAclElevated` RPC。
 *   - 第二态（cancelled/denied/failed）：展示 `manualAclFixCommands` 文本 +
 *     「请以管理员身份运行」提示。
 *
 * @module corum-ide-ui/client/AclElevationDialog
 */
import { useState } from 'react'
import { ConfirmDialog } from '@corum/corum-ui-base/client'

/** fixWorkspaceAclElevated RPC 返回类型（与 corum-platform 的 AclElevatedFixResult 同构）。 */
interface AclElevatedFixResult {
  ok: boolean
  outcome: 'fixed' | 'cancelled' | 'denied' | 'failed' | 'unsupported'
  detail: string
}

/** props：workspaceRoot/message 来自事件载荷，manualCommands 来自事件载荷，rpcCall 调 platform RPC。 */
export interface AclElevationDialogProps {
  /** 工作区根目录（传给 RPC 的 workspaceRoot）。 */
  workspaceRoot: string
  /** 用户可读文案（事件载荷的 message——issue #246：按失败原因分叉）。 */
  message: string
  /** 手工修复命令文本（事件载荷的 manualCommands）。 */
  manualCommands: string
  /** 命名空间化 RPC 调用函数（makeCorumRpcCall 的返回值）。 */
  rpcCall: <T, A extends object = Record<string, unknown>>(service: string, method: string, args: A) => Promise<T>
  /** 关闭 dialog（关闭后 AppFrame 清 state）。 */
  onClose: () => void
}

/**
 * ACL 提权修复引导 dialog。
 *
 * 第一态点「一键修复」→ 调 `platform/fixWorkspaceAclElevated`：
 *   - fixed：关 dialog + toast「已修复，请重试命令」；
 *   - cancelled/denied/failed：切第二态（展示 manualCommands + 「请以管理员身份运行」）。
 */
export function AclElevationDialog({ workspaceRoot, message, manualCommands, rpcCall, onClose }: AclElevationDialogProps) {
  const [busy, setBusy] = useState(false)
  // 第二态：修复失败/取消后展示手工命令。null = 第一态；string = 第二态文案。
  const [manualText, setManualText] = useState<string | null>(null)

  const onConfirm = (): void => {
    setBusy(true)
    void rpcCall<AclElevatedFixResult>('platform', 'fixWorkspaceAclElevated', { workspaceRoot })
      .then((result) => {
        if (result.ok && result.outcome === 'fixed') {
          // 已修复：toast 通知 + 关 dialog（toast 走 __corumNotify 桥，与 session-bar 同款）。
          const notify = (window as unknown as { __corumNotify?: (n: { tone: 'success'; title: string; message?: string }) => void }).__corumNotify
          notify?.({ tone: 'success', title: '已修复，请重试命令' })
          onClose()
        } else {
          // cancelled/denied/failed：切第二态。manualCommands 优先用事件载荷里的，
          // 载荷为空时退回 RPC 返回的 detail。
          setManualText(manualCommands !== '' ? manualCommands : result.detail)
        }
      })
      .catch(() => {
        // RPC 调用本身失败：也切第二态展示手工命令。
        setManualText(manualCommands !== '' ? manualCommands : '提权修复请求失败，请手动执行以下命令。')
      })
      .finally(() => { setBusy(false) })
  }

  // 第二态：展示手工命令（kind=info 单键告知，点主键关闭）。
  if (manualText !== null) {
    return (
      <ConfirmDialog
        title="需要手动修复"
        message={
          <>
            <div style={{ marginBottom: 8 }}>路径：<code>{workspaceRoot}</code></div>
            <div style={{ marginBottom: 8 }}>请以管理员身份运行以下命令：</div>
            <pre style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              background: 'var(--dsw-alias-glass-2, rgba(255,255,255,0.06))',
              borderRadius: 6, padding: '8px 10px', fontSize: 12,
              margin: 0,
            }}>
              {manualText}
            </pre>
          </>
        }
        kind="info"
        confirmLabel="知道了"
        onCancel={onClose}
      />
    )
  }

  // 第一态：一键修复确认。
  return (
    <ConfirmDialog
      title="工作区权限不足"
      message={
        <>
          <div style={{ marginBottom: 8 }}>路径：<code>{workspaceRoot}</code></div>
          <div style={{ marginBottom: 8 }}>{message}</div>
          <div>修复后请重试命令。</div>
        </>
      }
      tone="primary"
      confirmLabel="一键修复"
      cancelLabel="取消"
      busy={busy}
      busyLabel="修复中…"
      onConfirm={onConfirm}
      onCancel={onClose}
    />
  )
}
