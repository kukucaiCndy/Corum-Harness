import { describe, expect, it } from 'vitest'
import {
  CDP_TARGETS_FILENAME,
  CDP_TARGETS_VERSION,
  CdpTargetsConfigError,
  MAIN_INSTANCE_PORT,
  disabledReason,
  isMainInstancePort,
  resolveCdpTargetsPath,
  sampleCdpTargetsConfig,
  validateCdpTargetsConfig,
} from '../src/cdp-targets.ts'

/**
 * CDP 目标配置契约的判据。
 *
 * 这个模块存在的理由是一次真实故障（2026-10-30）：插件 `corum-cdp-targets` 原先按
 * 相对路径 import 技能包里的 `router/src/config.mjs`，而扩展包**只分发 `router/dist/`**
 * （已 bundle），不分发 `src/`。于是插件在装好的宿主里必然报：
 *
 *   cdpTargets: 无法加载 config.mjs（已尝试 3 个候选路径）: Cannot find module ...
 *
 * 单测各自绿、配置层也改过，实际功能却是 dead —— 这正是「依赖别人的源码目录」
 * 这类错误依赖的典型症状。把领域逻辑收进 SDK 后，这些用例钉住两件事：
 *  1. 校验语义与 router 运行时**不许漂移**（fail loud、不宽松回退）；
 *  2. 默认配置**不许写死端口**（用户口径：不同机器端口不同）。
 */
describe('validateCdpTargetsConfig — schema 严格性', () => {
  it('接受最小合法配置', () => {
    const cfg = validateCdpTargetsConfig({
      version: 1,
      targets: [{ id: 'rc3', ip: '127.0.0.1', port: 9333 }],
    })
    expect(cfg.version).toBe(CDP_TARGETS_VERSION)
    expect(cfg.autoDiscover).toBe(false)
    expect(cfg.targets).toHaveLength(1)
    expect(cfg.targets[0]).toEqual({ id: 'rc3', ip: '127.0.0.1', port: 9333 })
  })

  it('autoDiscover 只认布尔 true', () => {
    expect(validateCdpTargetsConfig({ version: 1, autoDiscover: true, targets: [] }).autoDiscover).toBe(true)
    // 字符串 'true' 不被当成 true（避免配置里写错类型还"能用"）
    expect(validateCdpTargetsConfig({ version: 1, autoDiscover: 'true' as never, targets: [] }).autoDiscover).toBe(false)
  })

  it('拒绝未知顶层键（拼写错误不能被静默忽略）', () => {
    expect(() => validateCdpTargetsConfig({ version: 1, targets: [], autoDisover: true }))
      .toThrow(/顶层含未知键/)
  })

  it('拒绝错误的 version', () => {
    expect(() => validateCdpTargetsConfig({ version: 2, targets: [] })).toThrow(/version 必须为 1/)
    expect(() => validateCdpTargetsConfig({ targets: [] })).toThrow(/version 必须为 1/)
  })

  it('拒绝非数组的 targets', () => {
    expect(() => validateCdpTargetsConfig({ version: 1, targets: {} })).toThrow(/targets 必须是数组/)
  })

  it('拒绝 target 里的未知键', () => {
    expect(() => validateCdpTargetsConfig({
      version: 1,
      targets: [{ id: 'a', ip: '127.0.0.1', port: 9333, browserUrl: 'http://x' }],
    })).toThrow(/含未知键/)
  })

  it('拒绝非法 id / ip / port', () => {
    const bad = [
      { id: 'bad id!', ip: '127.0.0.1', port: 9333 },
      { id: '-lead', ip: '127.0.0.1', port: 9333 },
      { id: 'a'.repeat(33), ip: '127.0.0.1', port: 9333 },
      { id: 'ok', ip: 'localhost', port: 9333 },        // DNS 名不接受
      { id: 'ok', ip: 'http://127.0.0.1', port: 9333 }, // URL 不接受
      { id: 'ok', ip: '127.0.0.1', port: 0 },
      { id: 'ok', ip: '127.0.0.1', port: 65536 },
      { id: 'ok', ip: '127.0.0.1', port: 9333.5 },
    ]
    for (const target of bad) {
      expect(() => validateCdpTargetsConfig({ version: 1, targets: [target] })).toThrow()
    }
  })

  it('拒绝重复 id 与重复 endpoint（否则「到底连了谁」不可判定）', () => {
    expect(() => validateCdpTargetsConfig({
      version: 1,
      targets: [
        { id: 'dup', ip: '127.0.0.1', port: 9333 },
        { id: 'dup', ip: '127.0.0.1', port: 9334 },
      ],
    })).toThrow(/重复 target id/)
    expect(() => validateCdpTargetsConfig({
      version: 1,
      targets: [
        { id: 'a', ip: '127.0.0.1', port: 9333 },
        { id: 'b', ip: '127.0.0.1', port: 9333 },
      ],
    })).toThrow(/重复 endpoint/)
  })

  it('错误带稳定 code 与 source，便于跨 bundle 分类', () => {
    try {
      validateCdpTargetsConfig({ version: 9, targets: [] }, '/tmp/x.json')
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(CdpTargetsConfigError)
      const e = error as CdpTargetsConfigError
      expect(e.code).toBe('cdp-targets/config-invalid')
      expect(e.source).toBe('/tmp/x.json')
      expect(e.message).toContain('/tmp/x.json')
    }
  })
})

describe('主实例护栏', () => {
  it('任何 IP 上的 9222 都视为主实例', () => {
    expect(isMainInstancePort(MAIN_INSTANCE_PORT)).toBe(true)
    expect(isMainInstancePort(9333)).toBe(false)
  })

  it('主实例端口未显式 allowMain ⇒ 报禁用原因（而不是在校验期直接拒绝）', () => {
    // 刻意的设计：让它出现在列表里并标 disabled，用户能看到「为什么连不上」，
    // 而不是配置里有一条 target 却毫无解释地消失。
    const cfg = validateCdpTargetsConfig({
      version: 1,
      targets: [{ id: 'main', ip: '127.0.0.1', port: MAIN_INSTANCE_PORT }],
    })
    expect(disabledReason(cfg.targets[0])).toMatch(/allowMain/)

    const allowed = validateCdpTargetsConfig({
      version: 1,
      targets: [{ id: 'main', ip: '127.0.0.1', port: MAIN_INSTANCE_PORT, allowMain: true }],
    })
    expect(disabledReason(allowed.targets[0])).toBeNull()
  })

  it('非主实例端口不需要 allowMain', () => {
    const cfg = validateCdpTargetsConfig({ version: 1, targets: [{ id: 'rc3', ip: '127.0.0.1', port: 9333 }] })
    expect(disabledReason(cfg.targets[0])).toBeNull()
  })
})

describe('配置文件路径解析', () => {
  it('CORUM_CDP_TARGETS 绝对路径优先', () => {
    expect(resolveCdpTargetsPath({ CORUM_CDP_TARGETS: '/abs/path.json', CORUM_HOME: '/h' }, '/home/u'))
      .toBe('/abs/path.json')
  })

  it('相对路径的 CORUM_CDP_TARGETS 被拒绝（防止相对 cwd 漂移）', () => {
    expect(() => resolveCdpTargetsPath({ CORUM_CDP_TARGETS: 'rel/path.json' }, '/home/u'))
      .toThrow(/必须是绝对路径/)
  })

  it('CORUM_HOME 优先于 DSH_HOME，最后回落 ~/.corum', () => {
    expect(resolveCdpTargetsPath({ CORUM_HOME: '/a', DSH_HOME: '/b' }, '/home/u'))
      .toBe(`/a/${CDP_TARGETS_FILENAME}`)
    expect(resolveCdpTargetsPath({ DSH_HOME: '/b' }, '/home/u'))
      .toBe(`/b/${CDP_TARGETS_FILENAME}`)
    expect(resolveCdpTargetsPath({}, '/home/u'))
      .toBe(`/home/u/.corum/${CDP_TARGETS_FILENAME}`)
  })
})

describe('示例配置：不写死端口', () => {
  it('默认开 autoDiscover 且 targets 为空', () => {
    const sample = sampleCdpTargetsConfig()
    expect(sample.version).toBe(CDP_TARGETS_VERSION)
    expect(sample.autoDiscover).toBe(true)
    expect(sample.targets).toEqual([])
  })

  it('示例本身能通过校验（不能给出一个自己都不合法的默认值）', () => {
    expect(() => validateCdpTargetsConfig(sampleCdpTargetsConfig())).not.toThrow()
  })

  it('示例里不含任何硬编码的常见端口（9333/9222）', () => {
    const ports = sampleCdpTargetsConfig().targets.map(t => t.port)
    expect(ports).not.toContain(9333)
    expect(ports).not.toContain(MAIN_INSTANCE_PORT)
  })
})
