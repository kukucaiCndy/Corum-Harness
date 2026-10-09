/**
 * corum-desktop Electron main：API Key 主密钥管理（safeStorage 封装）。
 *
 * 安全模型（TODO「API Key 本地加密存储」落地）：
 *
 * - **主密钥**：32 字节随机值，首次启动生成，永久保存在
 *   `$CORUM_HOME/.master-key`——保存形态是 `safeStorage.encryptString` 的
 *   密文（macOS Keychain / Windows DPAPI 系统级加密），**明文主密钥从不
 *   落盘**。
 * - **分发**：主密钥只在 spawn host 子进程时经环境变量
 *   `CORUM_CREDENTIALS_MASTER_KEY`（base64）注入；host 侧
 *   `@corum/corum-credentials-local` 用它对凭证值做 AES-256-GCM 加密落盘。
 *   与 dsh 的 inherited-environment 语义同构：进入进程环境的值即「该次
 *   启动的显式意图」。
 * - **可用性**：`safeStorage.isEncryptionAvailable()` 为 false（无桌面密钥环
 *   的 headless Linux 等）时不生成密钥文件、不注入 env——host 侧加密层
 *   随之进入「拒绝写密文」降级（明文存量仍可读），绝不把主密钥明文落盘。
 *
 * 本模块只在 Electron main 进程可用（safeStorage 在 renderer/host 不存在）。
 * @module corum-desktop/electron/credentials-key
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { safeStorage } from 'electron'

/** 注入 host 子进程的主密钥环境变量名（与 corum-credentials-local 的 MASTER_KEY_ENV 一致）。 */
export const MASTER_KEY_ENV = 'CORUM_CREDENTIALS_MASTER_KEY'

/**
 * 主密钥不可用时的启动策略环境变量（与 corum-credentials-local 的
 * `KEY_UNAVAILABLE_POLICY_ENV` 一致）。**只有 dev 态注入 `degrade`**：
 * 打包态不注入 = host 侧默认 `fail`（fail-loud，由冲烟测试拦在发版前）。
 */
export const KEY_UNAVAILABLE_POLICY_ENV = 'CORUM_CREDENTIALS_KEY_UNAVAILABLE'

/** 封装态主密钥文件名（$CORUM_HOME 下；safeStorage 密文，非明文）。 */
const MASTER_KEY_FILENAME = '.master-key'

/** 主密钥字节数（AES-256）。 */
const KEY_BYTES = 32

/**
 * 解析 CORUM_HOME（与 host 侧 resolveDesktopHome 同规则：显式 CORUM_HOME 优先，
 * 否则 ~/.corum；不触发 legacy 迁移——main 进程不写 home，只读/建密钥文件）。
 * @returns CORUM_HOME 绝对路径。
 */
function corumHome(): string {
  const configured = process.env.CORUM_HOME
  if (configured !== undefined && configured.trim() !== '') return configured
  return join(os.homedir(), '.corum')
}

/**
 * 读取或生成主密钥（base64），供注入 host 子进程。
 *
 * - 已存在 `$CORUM_HOME/.master-key`：`safeStorage.decryptString` 解出明文返回。
 * - 不存在：生成 32 字节随机主密钥，`safeStorage.encryptString` 封装后落盘
 *   （0600），返回明文。
 * - safeStorage 不可用或封装文件损坏：返回 `undefined`（host 侧加密层降级，
 *   见模块头）。损坏文件不覆盖——可能是钥匙串暂时不可用，保留现场。
 *
 * 每次 spawn host 都调用（进程内不缓存），safeStorage 加解密是一次系统调用，
 * 成本可忽略。
 *
 * @returns base64 编码的 32 字节主密钥；不可用返回 `undefined`。
 */
export function resolveMasterKeyB64(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) {
    process.stderr.write('[corum-desktop] safeStorage unavailable: credentials encryption disabled for this launch\n')
    return undefined
  }
  const file = join(corumHome(), MASTER_KEY_FILENAME)
  if (existsSync(file)) {
    try {
      const stored = readFileSync(file, 'utf8')
      const plaintext = safeStorage.decryptString(Buffer.from(stored, 'base64'))
      const key = Buffer.from(plaintext, 'base64')
      if (key.length !== KEY_BYTES) {
        process.stderr.write(`[corum-desktop] ${file}: unexpected master key length; leaving the file untouched\n`)
        return undefined
      }
      return plaintext
    } catch (error) {
      // 钥匙串条目被删/更换机器后文件解不开：不覆盖文件（避免既有密文凭证
      // 永久失锁），本次启动降级；用户可手动删除该文件后重启以重生成（代价
      // 是既有密文凭证失效，需重新录入）。
      process.stderr.write(`[corum-desktop] ${file}: decrypt failed (${String(error)}); leaving the file untouched\n`)
      return undefined
    }
  }
  const key = randomBytes(KEY_BYTES)
  const plaintext = key.toString('base64')
  try {
    mkdirSync(corumHome(), { recursive: true, mode: 0o700 })
    writeFileSync(file, safeStorage.encryptString(plaintext).toString('base64'), { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch (error) {
    process.stderr.write(`[corum-desktop] ${file}: persist failed (${String(error)}); credentials encryption disabled\n`)
    return undefined
  }
  process.stderr.write(`[corum-desktop] generated a safeStorage-wrapped master key at ${file}\n`)
  return plaintext
}
