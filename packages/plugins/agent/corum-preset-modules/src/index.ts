/**
 * @corum/corum-preset-modules — Agent 预设模块化（纯函数库）。
 *
 * 模块格式 / 导出 / 安装 / 前置依赖探测 / 随包模块列举。
 * 不注册 cordis 服务、不做 `apply(ctx)`；RPC 端点由 `@corum/corum-agent` 挂载。
 *
 * @module @corum/corum-preset-modules
 */

// 模块格式与校验（冻结）。
export {
  MODULE_MANIFEST_FILE,
  MODULE_SKILLS_DIR,
  MODULE_MCP_DIR,
  MODULE_ASSETS_DIR,
  MODULE_AVATAR_FILE,
  MODULE_FORMAT_VERSION,
  MODULE_SOURCE_KIND,
  isValidModuleId,
  validateManifest,
  validateMcpEntry,
  stripForModule,
} from './module-format.ts'
export type {
  ModuleManifest,
  ModuleMcpEntry,
  ModuleSource,
  McpRequirement,
  ModuleValidationError,
} from './module-format.ts'

// MCP 前置依赖探测（第①层）。
export {
  probeRequirement,
  probeRequirements,
  resolveCommand,
  expandWindowsEnvVars,
} from './mcp-requirements.ts'
export type { RequirementStatus, RequirementProbeInput } from './mcp-requirements.ts'

// CORUM_HOME 解析（委托官方 resolveDshHome，优先级对齐 corum-agent）。
export { resolveCorumHome } from './home.ts'

// 导出 / 安装。
export { exportProfileModule } from './module-export.ts'
export type { ExportModuleInput, ExportModuleResult } from './module-export.ts'
export { inspectProfileModule, installProfileModule } from './module-install.ts'
export type { ModuleInspection, InstallModuleInput, InstallModuleResult } from './module-install.ts'

// 安装说明（`requires`）的 sidecar 存放处 —— 见该文件头注：为什么**不能**放注册表。
export {
  MODULE_REQUIRES_FILE,
  moduleRequiresPath,
  readModuleRequires,
  mergeModuleRequires,
} from './requires-store.ts'

// zip 打包/解包（防 zip slip）。
export { packModuleArchive, unpackModuleArchive } from './module-archive.ts'

// 随包模块列举。
export { resolveShippedModulesRoot, listShippedModules, SHIPPED_MODULES_ENV } from './shipped-modules.ts'
