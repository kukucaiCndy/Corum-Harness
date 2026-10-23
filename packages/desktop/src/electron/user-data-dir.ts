/**
 * Electron `userData` 目录的解析与**一次性迁移**。
 *
 * ## 为什么目录**不能**放在 `os.tmpdir()`（2026-10-23 事故根因）
 *
 * 原实现（main.ts 的 `join(os.tmpdir(), 'corum-desktop-ud-…')`）把 Chromium 的
 * user-data-dir 放在系统临时目录里，理由是「多实例按 mode + 调试端口隔离」。
 * 隔离的**目的**是对的，**落点**是错的：user-data-dir 里有 `Local State`，而
 * Windows/Linux 上 `safeStorage` 的底层密钥（Chromium OSCrypt 主密钥，
 * `os_crypt.encrypted_key`，DPAPI 保护）**就存在这个文件里**。
 *
 * 于是「清 C 盘」这类日常操作（任何清理工具都会清 `%LOCALAPPDATA%\Temp`）会删掉
 * `Local State` ⇒ 下一代启动拿到一把**全新的** OSCrypt 密钥 ⇒
 * `$CORUM_HOME/.master-key`（用旧密钥封装）解不开 ⇒
 * `credentials-key.ts` 静默重建主密钥 ⇒ `.credentials.yaml` 里所有 `enc:v1:`
 * 凭证再也解不开 ⇒ host 的插件树在 `corum-credentials` 处抛
 * `master key is unavailable` / `authentication tag mismatch` ⇒ **exit 1**，
 * 界面只剩「后台启动失败：进程提前退出（code 1）」。
 *
 * 实测（2026-10-23，Windows 10 真机）：清空 `%TEMP%` 前后 `Local State` 的
 * `encrypted_key` 哈希从 `813366b5…` 变为 `4bb0f2a3…`，host `EXIT code=1`。
 *
 * ⇒ 落点改为**每用户持久目录**（Electron 的 `appData`：Windows `%APPDATA%`、
 * macOS `~/Library/Application Support`、Linux `$XDG_CONFIG_HOME`/`~/.config`）。
 * 目录**命名沿用旧叶子名**（`corum-desktop-ud-<mode>-<port>`），所以「按实例隔离」
 * 的语义完全不变，只是换了一个不会被清理工具动的根。
 *
 * ## 为什么光换目录还不够：必须迁移 `Local State`
 *
 * `Local State` 里的密钥是**旧目录**生成并封装的。若直接换根而不搬它，新目录会
 * 生成一把新密钥 ⇒ 所有既有用户的 `.master-key` 立刻失效 —— **等于把本模块要修的
 * 那个 bug 亲手复现一遍**。故首次在新根启动时，若新目录尚无 `Local State` 而旧
 * 临时目录有，就把它复制过来（密钥随之沿用，主密钥可继续解）。
 *
 * 迁移只在「新目录没有 `Local State`」时发生，因此是**幂等**的：一旦新根自持密钥，
 * 此后无论旧临时目录在不在（被清理工具删掉也无所谓）都不再复制。
 *
 * 边界：`CORUM_USER_DATA_DIR` 显式覆盖时**不做**迁移（调用方自己指定了落点，
 * 搬别人的密钥进去可能污染它自己的 profile）。dev/验证实例本就用它做隔离。
 *
 * ## 迁移只对 **Windows** 生效（三平台判定，2026-10-23 取证）
 *
 * 「密钥跟着 `Local State` 走」这个机制**只在 Windows 上成立**，故迁移只在
 * `win32` 执行（落点变更仍然三平台统一，见下）：
 *
 * - **win32 ✅ 需要迁移**：Electron 二进制含 `os_crypt_win.cc` + `DPAPIProvider`
 *   + `CryptProtectData`（实测 `strings` 断言），OSCrypt 主密钥以 `DPAPI` 密文
 *   存在 `Local State` 的 `os_crypt.encrypted_key` —— 删掉它 = 换密钥。
 * - **darwin ❌ 不需要**：二进制只有 `os_crypt_mac.mm` / `keychain_password_mac.mm`，
 *   **不含**任何 DPAPI/libsecret 符号；密钥在**钥匙串**（Keychain），`Local State`
 *   里根本没有 `os_crypt` 字段。实测（macOS，`safeStorage.encryptString` 之后）：
 *   `Local State` 的 `keys` 只有 `['uninstall_metrics']`，`os_crypt` 为 `None`。
 *   故在 darwin 上「搬 Local State」搬不到密钥，纯属无意义甚至有害的文件复制。
 * - **linux ⚠️ 未实测**：`secretStore` = `gnome-libsecret`（Chromium 在 Linux 上
 *   **不会**自动选后端，须显式 `password-store`，见 `platform/linux.ts`），机制上
 *   密钥同样在密钥环而非 `Local State`；但本仓**没有在 Linux 真机上验证过**
 *   `Local State` 是否含 `os_crypt`，故按「不需要迁移」处理并在此显式标注未验。
 *   补验方法：Linux 实机跑一次应用，检查 `Local State` 是否有 `os_crypt.encrypted_key`。
 *
 * ## 版本窗口（用户 2026-10-23 定）
 *
 * - **要服务的对象是「0.6.0 及更早」的安装**：它们的 userData 在 `os.tmpdir()`
 *   （{@link LAST_TMPDIR_VERSION}）。**不是**「只在这些版本上运行」——见
 *   {@link shouldMigrateLocalState}：迁移恰恰由**新版本**在升级后的首次启动执行，
 *   故不能按运行版本判断，改用幂等。
 * - **1.0.0 之后应删除本迁移代码**（{@link MIGRATION_REMOVE_AT}）：届时旧安装已
 *   无人使用，留着只是死代码 + 每次启动一次 `existsSync`。删除清单见该常量注释。
 *
 * @module corum-desktop/electron/user-data-dir
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 目录叶子名前缀（沿用旧命名，使「按 mode + 端口隔离」的语义不变）。 */
export const USER_DATA_LEAF_PREFIX = 'corum-desktop-ud-'

/** Chromium 存 OSCrypt 主密钥的文件名（`safeStorage` 在 Windows/Linux 的底座）。 */
export const LOCAL_STATE_FILENAME = 'Local State'

/** 显式指定 user-data-dir 的环境变量（dev / 验证实例用）。 */
export const USER_DATA_DIR_ENV = 'CORUM_USER_DATA_DIR'

/**
 * 「最后一个把 userData 放在 `os.tmpdir()` 的版本」= 会产出旧临时目录的版本。
 *
 * 这是**事实记录**（用于文档、日志与后续删除判断），**不是运行期门槛** ——
 * 原因见 {@link shouldMigrateLocalState} 的注释：门槛若按「当前运行版本」比较，
 * 会让升级上来的老用户拿不到迁移（等于修复失效）。0.6.0 是已发布且仍带该 bug 的
 * 版本（`git show v0.6.0:packages/desktop/src/electron/main.ts` 可复核），
 * 故 0.6.0 及更早的安装机上**确实存在**旧临时目录。
 */
export const LAST_TMPDIR_VERSION = '0.6.0'

/**
 * 迁移代码的移除线：**版本 ≥ 它时整块删除**（用户 2026-10-23 定）。
 *
 * 删除时一并去掉：
 * - 本文件里的 `MIGRATION_FIRST_FIXED_VERSION` / `shouldMigrateLocalState` /
 *   `migrateLocalState` / `legacyDir` 字段与全部旧目录探测；
 * - `main.ts` 里 `prepareUserDataDir` 的 `degraded` 告警可保留（退化与迁移无关），
 *   但迁移日志一行可删；
 * - `tests/user-data-dir.test.mjs` 里 5 条迁移用例（保留落点/退化/幂等之外的）。
 * 判断依据是「还有没有 <0.6.0 的安装在用」，不是本常量本身——它只是提醒。
 */
export const MIGRATION_REMOVE_AT = '1.0.0'

/**
 * 本次启动是否需要**尝试**执行「旧临时目录 → 持久目录」的 `Local State` 迁移。
 *
 * 判据只有一条：**平台是 win32**（只有 Windows 把 OSCrypt 主密钥放在 `Local State`；
 * darwin 用钥匙串、linux 用 libsecret，见模块注释的取证）。
 *
 * ## 为什么**没有**版本门槛（2026-10-23 修正，代价已复核）
 *
 * 最初写过「运行版本 ≤ 0.6.0 才迁移」，那是**方向性错误**：
 * 迁移代码跑在**修复版自己**的进程里。0.6.0 的老用户升级到 0.7.0 后，
 * `readAppVersion()` 读到的是 **0.7.0**，按「≤0.6.0」判定 ⇒ **不迁移** ⇒
 * 主密钥换新 ⇒ 凭证全失效 —— 恰好把本次修复要解决的问题原样复现。
 * 版本比较回答的是「我是谁」，而这里要问的是「这台机器上有没有旧安装的残骸」。
 *
 * 所以「只运行一次」**不靠版本号**，而由 {@link migrateLocalState} 的**幂等性**保证：
 * 新落点一旦自带 `Local State` 就直接跳过。于是每次启动都「尝试」，但真正复制只在
 * 首次发生；代价是每次启动一次 `existsSync`（微秒级），可接受。
 *
 * 版本维度仍有一条**下限**（不是门槛，是事实）：本函数只存在于含此修复的版本里，
 * 更早的版本根本没有这段代码，自然不会运行它。
 * @param platform - 运行平台（`process.platform`）。
 * @returns 值得去探测旧目录时为 true。
 */
export function shouldMigrateLocalState(platform: string): boolean {
  return platform === 'win32'
}

/** 解析输入：全部显式传参，便于脱离 Electron 单测。 */
export interface UserDataDirInput {
  /** 进程环境（读 `CORUM_USER_DATA_DIR` / `CORUM_DESKTOP_MODE` / `CORUM_DEBUG_PORT`）。 */
  readonly env: Record<string, string | undefined>
  /** 每用户持久配置根（Electron `app.getPath('appData')`）。 */
  readonly appData: string
  /** 系统临时目录（`os.tmpdir()`）——仅用于定位**旧**目录做迁移，绝不作为落点。 */
  readonly tempRoot: string
  /** 运行平台（`process.platform`）。决定是否探测旧目录（只有 win32 需要）。 */
  readonly platform?: string
}

/** 解析结果。 */
export interface UserDataDirPlan {
  /** 本次启动使用的 user-data-dir（绝对路径）。 */
  readonly dir: string
  /** 主落点不可写时的备用落点（旧行为：临时目录。仅作退化，正常路径不会用到）。 */
  readonly fallbackDir: string
  /** 旧版遗留目录（仅当存在可迁移的旧目录时给出）。 */
  readonly legacyDir?: string
  /** 是否由 `CORUM_USER_DATA_DIR` 显式指定（显式指定时不做迁移）。 */
  readonly explicit: boolean
}

/**
 * 目录叶子名：`corum-desktop-ud-<mode>-<port>`。
 *
 * 空字符串按未设置处理（与 `??` 相比多了「空值归一」这一步）：`CORUM_DEBUG_PORT=`
 * 会得到 `corum-desktop-ud-minimal-` 这种带尾横线的怪名字，且与 `noport` 是两个
 * 不同的锁——同一个「未设端口」的实例被拆成两份 profile。
 * @param env - 进程环境。
 * @returns 目录叶子名。
 */
export function userDataLeaf(env: Record<string, string | undefined>): string {
  const mode = (env['CORUM_DESKTOP_MODE'] ?? '') === '' ? 'minimal' : (env['CORUM_DESKTOP_MODE'] as string)
  const port = (env['CORUM_DEBUG_PORT'] ?? '') === '' ? 'noport' : (env['CORUM_DEBUG_PORT'] as string)
  return `${USER_DATA_LEAF_PREFIX}${mode}-${port}`
}

/**
 * 判断 `target` 是否在 `root` 之下（含相等）。
 * @param target - 待判定路径。
 * @param root - 根路径。
 * @returns target 等于 root 或位于其下时为 true。
 */
export function isUnder(target: string, root: string): boolean {
  const t = resolve(target)
  const r = resolve(root)
  if (t === r) return true
  return t.startsWith(r.endsWith(sep) ? r : `${r}${sep}`)
}

/**
 * 解析本次启动的 user-data-dir。
 *
 * 优先级：`CORUM_USER_DATA_DIR` > `appData/corum-desktop-ud-<mode>-<port>`。
 * `legacyDir` 只在**未显式指定**且旧临时目录确实存在 `Local State` 时给出
 * （没有可迁移的内容就不必提它，日志也会干净）。
 * @param input - 解析输入。
 * @returns 落点计划。
 */
export function planUserDataDir(input: UserDataDirInput): UserDataDirPlan {
  const leaf = userDataLeaf(input.env)
  const legacyDir = join(input.tempRoot, leaf)
  const explicitValue = input.env[USER_DATA_DIR_ENV]
  if (explicitValue !== undefined && explicitValue.trim() !== '') {
    const dir = resolve(explicitValue)
    // 显式指定时备用落点就是它自己：调用方已经选好，退化无意义
    // （退化到别处会让它下次找不到自己的 profile）。
    return { dir, fallbackDir: dir, explicit: true }
  }
  const dir = join(input.appData, leaf)
  // 只在需要迁移的平台（win32）探测旧目录；其它平台连 `existsSync` 都不做。
  // 「只运行一次」由 migrateLocalState 的幂等性保证，不靠版本比较（理由见其注释）。
  const needsMigration = shouldMigrateLocalState(input.platform ?? process.platform)
  if (!needsMigration || !existsSync(join(legacyDir, LOCAL_STATE_FILENAME))) {
    return { dir, fallbackDir: legacyDir, explicit: false }
  }
  return { dir, fallbackDir: legacyDir, legacyDir, explicit: false }
}

/** 迁移结果（供日志与测试断言）。 */
export interface LocalStateMigration {
  /** 是否真的复制了文件。 */
  readonly migrated: boolean
  /** 人类可读的原因（写进 stderr，便于事后定位）。 */
  readonly reason: string
}

/** {@link prepareUserDataDir} 的结果。 */
export interface UserDataDirReady {
  /** 最终可用的 user-data-dir（绝对路径）。 */
  readonly dir: string
  /** Local State 是否从旧临时目录迁移过来。 */
  readonly migrated: boolean
  /** 是否退化到了备用落点（持久目录不可写时）。 */
  readonly degraded: boolean
  /** 人类可读的原因（写进 stderr）。 */
  readonly reason: string
}

/**
 * 把旧临时目录的 `Local State` 复制到新落点（**只在需要且安全时**）。
 *
 * 三种不该复制的场合，各有明确判据：
 * - 显式指定落点（`explicit`）：调用方自己管，搬别人的密钥进去可能污染其 profile；
 * - 新落点已有 `Local State`：说明它已自带密钥，覆盖会把**当前可用的**密钥换成旧的；
 * - 旧目录没有 `Local State`：没有可搬的内容。
 *
 * 复制前先建目标目录（`copyFileSync` 不会自建父目录），使本函数成为「调用后
 * 目标目录必然存在」的单点——调用方不必再单独 mkdir。
 * @param plan - {@link planUserDataDir} 的结果。
 * @returns 迁移是否发生及原因。
 */
export function migrateLocalState(plan: UserDataDirPlan): LocalStateMigration {
  if (plan.explicit) {
    mkdirSync(plan.dir, { recursive: true })
    return { migrated: false, reason: 'user-data-dir 由 CORUM_USER_DATA_DIR 显式指定，不迁移' }
  }
  const target = join(plan.dir, LOCAL_STATE_FILENAME)
  if (existsSync(target)) {
    return { migrated: false, reason: '新落点已自带 Local State（密钥沿用新落点）' }
  }
  if (plan.legacyDir === undefined) {
    mkdirSync(plan.dir, { recursive: true })
    return { migrated: false, reason: '无旧临时目录可迁移' }
  }
  const source = join(plan.legacyDir, LOCAL_STATE_FILENAME)
  mkdirSync(plan.dir, { recursive: true })
  try {
    copyFileSync(source, target)
  } catch (error) {
    // 迁移失败**不能**弄死启动：最坏结果是回到「主密钥需重建」的旧行为，
    // 而拒绝启动会让用户连界面都看不到。交由 credentials-key 的既有兜底处理。
    return { migrated: false, reason: `复制 Local State 失败（忽略）：${String(error)}` }
  }
  return { migrated: true, reason: `已从 ${plan.legacyDir} 迁移 Local State（沿用既有 safeStorage 密钥）` }
}

/**
 * 建目录并迁移，**保证返回一个可用落点**（持久目录不可写时退化到备用根）。
 *
 * 为什么需要退化而不是直接抛：旧实现落在 `os.tmpdir()`，那是**永远可写**的，
 * 所以「建目录失败」这个分支从前根本不存在。换到 `appData` 后它变成真实可能
 * （只读漫游配置、被安全软件锁定的配置目录、CI 里的受限账户）。此时若直接抛，
 * 就是拿「清 C 盘会坏」换成「配置目录只读就起不来」——**用一个新的失败模式换旧的**，
 * 不可接受。故：建目录/迁移失败 ⇒ 退到备用根（tempRoot，即旧行为）并**大声**
 * 告警（把「这台机器上仍然是 tmp 语义、有可能再遇到 2026-10-23 那个事故」的原因
 * 直接写在日志里），绝不让启动失败。
 * @param plan - {@link planUserDataDir} 的结果。
 * @returns 最终落点与迁移/退化状态。
 */
export function prepareUserDataDir(plan: UserDataDirPlan): UserDataDirReady {
  try {
    const migration = migrateLocalState(plan)
    return { dir: plan.dir, migrated: migration.migrated, degraded: false, reason: migration.reason }
  } catch (error) {
    // 持久落点建不出来（EPERM/EACCES/ENOSPC…）：退到旧行为，但要大声说明。
    const fallback = plan.fallbackDir
    try {
      mkdirSync(fallback, { recursive: true })
    } catch (fallbackError) {
      // 连备用根都建不出来：此时已无路可退，交给上层按启动失败处理
      // （用户至少能从这条消息知道是「目录不可写」，而不是一句笼统的 code 1）。
      throw new Error(
        `user-data-dir 不可用：${plan.dir} 与备用 ${fallback} 都无法创建`
        + `（${String(error)} / ${String(fallbackError)}）`,
      )
    }
    return {
      dir: fallback,
      migrated: false,
      degraded: true,
      reason: `持久目录不可写（${String(error)}），已退化到 ${fallback}`
        + '——注意：该落点位于临时目录，清理工具删除它会导致全部已保存凭证失效',
    }
  }
}
