/**
 * 平台事实源的语义守卫（不依赖 cordis 装配，直测导出面）：
 *
 * 1. `getPlatform()` 必须返回**实际运行平台**（`process.platform`），
 *    绝不回放打包意图（已拍板边界 ①：行为事实源只有一个 = 实际运行平台）。
 * 2. `getBakedTargetPlatform()` 在本包直构建（未烘入常量）时必须返回
 *    `undefined`，且读取动作**不得抛**（typeof 守卫在，自由标识符不炸）。
 * 3. 两个事实**分开命名**（已拍板边界 ③）：服务面上必须同时存在
 *    `getPlatform` 与 `getBakedTargetPlatform` 两个不同名的方法。
 */
import { describe, expect, it } from 'vitest'
import { PlatformService, bakedTargetPlatform } from '../src/index.ts'

/** 不装配 cordis：以最小假 ctx 拿到实例（TypertRemoteService 只在本测用不到的面触 ctx）。 */
function makeService(): PlatformService {
  const fakeCtx = {} as ConstructorParameters<typeof PlatformService>[0]
  return Object.create(PlatformService.prototype) as PlatformService
}

describe('corum-platform 平台事实源', () => {
  it('getPlatform() 返回实际运行平台（process.platform）', () => {
    expect(makeService().getPlatform()).toBe(process.platform)
  })

  it('getBakedTargetPlatform() 未透传时返回 undefined 且不抛', () => {
    const saved = process.env.CORUM_TARGET_PLATFORM
    delete process.env.CORUM_TARGET_PLATFORM
    try {
      expect(makeService().getBakedTargetPlatform()).toBeUndefined()
      expect(bakedTargetPlatform()).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.CORUM_TARGET_PLATFORM = saved
    }
  })

  it('getBakedTargetPlatform() 读 main 透传的环境变量；非白名单值按无事实处理', () => {
    const saved = process.env.CORUM_TARGET_PLATFORM
    try {
      process.env.CORUM_TARGET_PLATFORM = 'linux'
      expect(bakedTargetPlatform()).toBe('linux')
      process.env.CORUM_TARGET_PLATFORM = 'freebsd' // 非出包平台（手滑写错 flag）
      expect(bakedTargetPlatform()).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.CORUM_TARGET_PLATFORM
      else process.env.CORUM_TARGET_PLATFORM = saved
    }
  })

  it('两个事实分开命名（getPlatform ≠ getBakedTargetPlatform）', () => {
    const service = makeService()
    expect(typeof service.getPlatform).toBe('function')
    expect(typeof service.getBakedTargetPlatform).toBe('function')
    expect(service.getPlatform).not.toBe(service.getBakedTargetPlatform)
  })
})
