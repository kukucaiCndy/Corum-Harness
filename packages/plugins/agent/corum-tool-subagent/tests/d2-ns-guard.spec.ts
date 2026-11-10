/**
 * D2 纠偏守卫：settings ns = cordis entry id（rc3 机制根基因）。
 *
 * 研究报告 `429e00b9` 确认三个 settings registrar 的 **settings ns 与 patch 行 id
 * 不一致**——rc3 用 `entry.options.id` 作为 settings ns（`describe()` 的 `ns` 字段、
 * `write()` 的 ns 参数），**不存在** entry id → ns 的映射。旧消费方读的 ns（`corum-subagent`
 * / `corum-memory` / `ui-onboarding`）与 patch 行 id（`corum-subagent-settings`
 * / `corum-memory-settings` / `corum-ui-onboarding-settings`）不匹配 ⇒ describe 读空、
 * write 抛 `No configurable plugin entry`。
 *
 * 裁决 A：消费方 ns 对齐行 id。本 spec 断言：
 *   1. `cordis.patch.yml` 三个行 `id:` 与三个导出常量**逐字相等**（防回潮）；
 *   2. registrar 不再调 `configure({auto:true})`（autoGenerate 默认 true，近似 no-op）；
 *   3. 旧 `settings.yaml` 段名 → 新 ns 的一次性迁移幂等 + 新值优先。
 *
 * **为什么不只喂同常量造成自证**：旧测试 stub 直接喂 `CORUM_MEMORY_SETTINGS_NAMESPACE`
 * 常量给 describe stub——测不出「真实 patch 行 id ≠ 常量」的断点。本 spec 从
 * `cordis.patch.yml` 文件实读行 id，与源码常量逐一相等。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ── 三个导出常量（从各自源码模块 import）──────────────────────────────────
import { CORUM_SUBAGENT_SETTINGS_NAMESPACE } from '../src/settings-namespace.ts'
import { CORUM_MEMORY_SETTINGS_NAMESPACE } from '../../corum-memory/src/memory-config.ts'

// `WELCOME_NOTICE_SETTINGS_NAMESPACE` 在 `session/corum-ui-settings-models` 包里，
// vitest 无法跨 workspace 边界解析——改为从源码文件实读常量值（与 patch.yml
// 对账时同口径：都是文件文本断言）。
const ONBOARDING_NS_SOURCE = join(
  import.meta.dirname,
  '../../../session/corum-ui-settings-models/src/onboarding-copy.ts',
)
const WELCOME_NOTICE_SETTINGS_NAMESPACE = (() => {
  const src = readFileSync(ONBOARDING_NS_SOURCE, 'utf8')
  const match = /export const WELCOME_NOTICE_SETTINGS_NAMESPACE = '([^']+)'/.exec(src)
  if (match === null) throw new Error('WELCOME_NOTICE_SETTINGS_NAMESPACE not found in source')
  return match[1]!
})()

// ── 迁移模块（从 corum-agent 的迁移模块 import）──────────────────────────
import {
  migrateLegacySettingsNs,
  parseYamlSectionsDeep,
  LEGACY_NS_MAPPING,
  MIGRATION_MARKER,
  type SettingsMigrationFace,
} from '../../corum-agent/src/settings-legacy-migration.ts'

/** patch.yml 的绝对路径（从 corum-tool-subagent/tests 往上走到 desktop）。 */
const PATCH_YML = join(import.meta.dirname, '../../../../desktop/cordis.patch.yml')

/** 从 patch.yml 实读某个 registrar 子路径的 `id:` 字段。
 *
 * patch.yml 的 entry 格式是先 `- id: <id>` 再 `name: '@corum/...'`：
 *   ```yaml
 *   - id: corum-subagent-settings
 *     name: '@corum/corum-tool-subagent/settings-registrar'
 *   ```
 * 故找 `name:` 行后回溯到紧邻的 `- id:` 行。 */
function readPatchEntryId(registrarPath: string): string {
  const text = readFileSync(PATCH_YML, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(`name: '@corum/${registrarPath}'`)) {
      // 回溯找紧邻的 `- id:` 行。
      for (let j = i - 1; j >= 0; j--) {
        const idMatch = /^\s*- id:\s*(\S+)/.exec(lines[j]!)
        if (idMatch !== null) return idMatch[1]!
      }
    }
  }
  throw new Error(`patch entry id not found for ${registrarPath}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. patch 行 id ↔ 消费方 ns 常量逐字相等（防回潮的核心断言）
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 守卫：patch 行 id = 消费方 ns 常量（rc3 settings ns = entry id）', () => {
  it('corum-subagent-settings: patch id = CORUM_SUBAGENT_SETTINGS_NAMESPACE', () => {
    const patchId = readPatchEntryId('corum-tool-subagent/settings-registrar')
    expect(patchId).toBe(CORUM_SUBAGENT_SETTINGS_NAMESPACE)
    expect(CORUM_SUBAGENT_SETTINGS_NAMESPACE).toBe('corum-subagent-settings')
  })

  it('corum-memory-settings: patch id = CORUM_MEMORY_SETTINGS_NAMESPACE', () => {
    const patchId = readPatchEntryId('corum-memory/settings-registrar')
    expect(patchId).toBe(CORUM_MEMORY_SETTINGS_NAMESPACE)
    expect(CORUM_MEMORY_SETTINGS_NAMESPACE).toBe('corum-memory-settings')
  })

  it('corum-ui-onboarding-settings: patch id = WELCOME_NOTICE_SETTINGS_NAMESPACE', () => {
    const patchId = readPatchEntryId('corum-ui-settings-models/settings-registrar')
    expect(patchId).toBe(WELCOME_NOTICE_SETTINGS_NAMESPACE)
    expect(WELCOME_NOTICE_SETTINGS_NAMESPACE).toBe('corum-ui-onboarding-settings')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. registrar 不再调 configure({auto:true})（D2 纠偏第 2 点）
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 守卫：三个 registrar 不再调 configure({auto:true})', () => {
  it('corum-tool-subagent registrar: 无 configure({auto:true})', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/settings-registrar.ts'), 'utf8')
    // 去掉注释后检查。
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toContain('configure({ auto: true })')
    expect(code).not.toContain("configure({auto:true})")
  })

  it('corum-memory registrar: 无 configure({auto:true})', () => {
    const src = readFileSync(join(import.meta.dirname, '../../corum-memory/src/settings-registrar.ts'), 'utf8')
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toContain('configure({ auto: true })')
    expect(code).not.toContain("configure({auto:true})")
  })

  it('corum-ui-onboarding registrar: 无 configure({auto:true})', () => {
    const src = readFileSync(join(import.meta.dirname, '../../../session/corum-ui-settings-models/src/settings-registrar.ts'), 'utf8')
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toContain('configure({ auto: true })')
    expect(code).not.toContain("configure({auto:true})")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 旧 settings.yaml 段名 → 新 ns 迁移（幂等 + 新值优先）
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 迁移：旧 settings.yaml 段 → 新 ns（幂等 + 新值优先）', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-d2-migrate-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10 })
  })

  /** 造一个 settings.yaml.imported 文件（旧段名 + 旧值）。 */
  function writeImported(sections: Record<string, Record<string, unknown>>): void {
    const lines: string[] = []
    for (const [section, values] of Object.entries(sections)) {
      lines.push(`${section}:`)
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'object' && value !== null) {
          lines.push(`  ${key}:`)
          for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
            lines.push(`    ${subKey}: ${typeof subVal === 'string' ? subVal : subVal}`)
          }
        } else {
          lines.push(`  ${key}: ${value}`)
        }
      }
    }
    writeFileSync(join(home, 'settings.yaml.imported'), lines.join('\n'), 'utf8')
  }

  /** 造一个 settings 服务面 stub（describe + update）。 */
  function makeSettingsStub(
    describeRows: ReadonlyArray<{ ns: string; user?: unknown }>,
    updates: Array<{ ns: string; patch: object }> = [],
  ): SettingsMigrationFace & { getUpdates: () => typeof updates } {
    return {
      describe: () => describeRows,
      update: async (ns: string, patch: object) => { updates.push({ ns, patch }) },
      getUpdates: () => updates,
    }
  }

  it('旧段 corum-subagent 迁移到 corum-subagent-settings（补缺值）', () => {
    writeImported({
      'corum-subagent': { maxParallelChildren: 8 },
    })
    const stub = makeSettingsStub([]) // 新 ns 无显式值
    const result = migrateLegacySettingsNs(home, stub)
    expect(result).not.toBeNull()
    expect(result!.migrated).toHaveLength(1)
    expect(result!.migrated[0]!.oldNs).toBe('corum-subagent')
    expect(result!.migrated[0]!.newNs).toBe('corum-subagent-settings')
    expect(stub.getUpdates()).toHaveLength(1)
    expect(stub.getUpdates()[0]!.ns).toBe('corum-subagent-settings')
    // marker 已写。
    expect(existsSync(join(home, MIGRATION_MARKER))).toBe(true)
  })

  it('新值优先：目标 ns 已有显式用户值时跳过（不覆盖）', () => {
    writeImported({
      'corum-subagent': { maxParallelChildren: 8 },
    })
    // 新 ns 已有用户值。
    const stub = makeSettingsStub([
      { ns: 'corum-subagent-settings', user: { maxParallelChildren: 4 } },
    ])
    const result = migrateLegacySettingsNs(home, stub)
    expect(result).not.toBeNull()
    expect(result!.migrated).toHaveLength(0)
    expect(result!.skipped).toHaveLength(1)
    expect(result!.skipped[0]!.reason).toContain('already has explicit')
    expect(stub.getUpdates()).toHaveLength(0)
  })

  it('幂等：marker 已存在时跳过（不重复迁移）', () => {
    writeImported({
      'corum-subagent': { maxParallelChildren: 8 },
    })
    // 先写 marker。
    writeFileSync(join(home, MIGRATION_MARKER), '{"done": true}', 'utf8')
    const stub = makeSettingsStub([])
    const result = migrateLegacySettingsNs(home, stub)
    expect(result).toBeNull()
    expect(stub.getUpdates()).toHaveLength(0)
  })

  it('.imported 文件不存在时返回 null（首次安装无旧文件）', () => {
    const stub = makeSettingsStub([])
    const result = migrateLegacySettingsNs(home, stub)
    expect(result).toBeNull()
  })

  it('坏值 warn 不中断：旧段值类型不对时跳过该字段但继续迁移其他', () => {
    writeImported({
      'corum-subagent': {
        maxParallelChildren: 'not-a-number', // 坏值
        defaultModel: { provider: 'zai', model: 'glm-5.3-flash' }, // 好值
      },
    })
    const stub = makeSettingsStub([])
    const result = migrateLegacySettingsNs(home, stub)
    expect(result).not.toBeNull()
    expect(result!.badValues.length).toBeGreaterThan(0)
    expect(result!.badValues[0]!.field).toBe('maxParallelChildren')
    // 好值仍然迁移。
    expect(result!.migrated).toHaveLength(1)
    expect(stub.getUpdates()).toHaveLength(1)
  })

  it('三段同时迁移（corum-subagent + corum-memory + ui-onboarding）', () => {
    writeImported({
      'corum-subagent': { maxParallelChildren: 6 },
      'corum-memory': { enabled: false, readPromoteThreshold: 10 },
      'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' },
    })
    const stub = makeSettingsStub([])
    const result = migrateLegacySettingsNs(home, stub)
    expect(result).not.toBeNull()
    expect(result!.migrated).toHaveLength(3)
    const newNss = result!.migrated.map(m => m.newNs).sort()
    expect(newNss).toEqual([
      'corum-memory-settings',
      'corum-subagent-settings',
      'corum-ui-onboarding-settings',
    ])
  })

  it('LEGACY_NS_MAPPING 覆盖三个旧段名', () => {
    expect(LEGACY_NS_MAPPING.get('corum-subagent')).toBe('corum-subagent-settings')
    expect(LEGACY_NS_MAPPING.get('corum-memory')).toBe('corum-memory-settings')
    expect(LEGACY_NS_MAPPING.get('ui-onboarding')).toBe('corum-ui-onboarding-settings')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. parseYamlSectionsDeep — YAML 段解析器（迁移模块的解析基础设施）
// ─────────────────────────────────────────────────────────────────────────────

describe('parseYamlSectionsDeep — YAML 段解析', () => {
  it('扁平键值对', () => {
    const sections = parseYamlSectionsDeep([
      'corum-subagent:',
      '  maxParallelChildren: 8',
    ].join('\n'))
    expect(sections['corum-subagent']).toEqual({ maxParallelChildren: 8 })
  })

  it('嵌套映射（defaultModel.provider/model）', () => {
    const sections = parseYamlSectionsDeep([
      'corum-subagent:',
      '  defaultModel:',
      '    provider: zai',
      '    model: glm-5.3-flash',
    ].join('\n'))
    expect(sections['corum-subagent']?.defaultModel).toEqual({
      provider: 'zai',
      model: 'glm-5.3-flash',
    })
  })

  it('布尔/null/数字标量解析', () => {
    const sections = parseYamlSectionsDeep([
      'corum-memory:',
      '  enabled: false',
      '  capacity: null',
      '  readPromoteThreshold: 5',
    ].join('\n'))
    expect(sections['corum-memory']).toEqual({
      enabled: false,
      capacity: null,
      readPromoteThreshold: 5,
    })
  })

  it('多段共存', () => {
    const sections = parseYamlSectionsDeep([
      'corum-subagent:',
      '  maxParallelChildren: 8',
      'corum-memory:',
      '  enabled: true',
      'ui-onboarding:',
      '  welcomeNoticeVersion: v1',
    ].join('\n'))
    expect(Object.keys(sections).sort()).toEqual(['corum-memory', 'corum-subagent', 'ui-onboarding'])
  })

  it('空行与注释不干扰', () => {
    const sections = parseYamlSectionsDeep([
      '# comment',
      '',
      'corum-subagent:',
      '  # inline comment',
      '  maxParallelChildren: 8',
    ].join('\n'))
    expect(sections['corum-subagent']).toEqual({ maxParallelChildren: 8 })
  })

  it('语法残缺不抛错', () => {
    expect(() => parseYamlSectionsDeep(':::\n\t\tbad:')).not.toThrow()
  })
})
