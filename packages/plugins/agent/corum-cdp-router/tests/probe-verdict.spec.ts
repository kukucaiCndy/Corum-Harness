/**
 * `listTargets` 的探活判定 —— 本次修的两处谎报都在这里锁住。
 *
 * ## 为什么这个测试必须存在
 *
 * 修之前的状态只有一根轴：`disabledReason()`（护栏）。于是一条指向**早已关闭**端口的
 * 配置照样显示「可用」——用户实测踩到：三条配置全不通，界面全绿。
 *
 * 加探活时又踩到第二层坑：`probePort()` 用**返回值**表达失败（不可达时回
 * `reachable: false` 的 blank 对象），**不抛错**。写成 `await probePort(...)` 然后当成功，
 * 会让每个死端口都报「在线」。这个测试用一条真·死端口把那条判据钉住。
 *
 * ## 为什么不用 mock 掉 probePort
 *
 * mock 掉就测不到「返回值 vs 抛错」这个区别（那正是缺陷形态）。这里用 127.0.0.1 上一个
 * 必然没人监听的端口做真实探测，代价是一次 900ms 超时。
 */

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { disabledReason, readConfig, writeConfig } from '../src/targets.js'

/** 一个几乎不可能有人监听的端口（>1024 且非常用）。 */
const DEAD_PORT = 19999

const created: string[] = []

/** 造一个临时配置文件路径（不污染真实 home）。 */
function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-targets-'))
  created.push(dir)
  return path.join(dir, 'cdp-targets.json')
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响断言 */ }
  }
})

describe('disabledReason（策略轴）', () => {
  it('9222 未给 allowMain ⇒ 有禁用原因', () => {
    expect(disabledReason({ id: 'm', ip: '127.0.0.1', port: 9222 })).not.toBeNull()
    expect(disabledReason({ id: 'm', ip: '127.0.0.1', port: 9222, allowMain: true })).toBeNull()
  })

  it('非 9222 ⇒ 恒为 null（护栏只认主实例端口）', () => {
    expect(disabledReason({ id: 'v', ip: '127.0.0.1', port: 9333 })).toBeNull()
    expect(disabledReason({ id: 'd', ip: '127.0.0.1', port: DEAD_PORT })).toBeNull()
  })
})

describe('配置往返', () => {
  it('写进去的 targets 能原样读回来（含 allowMain/readOnly）', () => {
    const p = tempConfigPath()
    writeConfig(p, {
      version: 1,
      autoDiscover: true,
      targets: [{ id: 'v', ip: '127.0.0.1', port: 9333, readOnly: true, allowMain: false }],
    })
    const { config, exists } = readConfig(p)
    expect(exists).toBe(true)
    expect(config.targets).toHaveLength(1)
    expect(config.targets[0]).toMatchObject({ id: 'v', port: 9333, readOnly: true, allowMain: false })
  })

  it('清空 targets 是合法配置（用户裁定「不再预置任何目标」后的常态）', () => {
    const p = tempConfigPath()
    writeConfig(p, { version: 1, autoDiscover: true, targets: [] })
    const { config } = readConfig(p)
    expect(config.targets).toEqual([])
    expect(config.autoDiscover).toBe(true)
  })
})

describe('probePort 的失败语义（本次缺陷的根因形态）', () => {
  it('死端口不抛错，而是回 reachable: false —— 调用方必须读返回值', async () => {
    const { probePort } = await import('../src/discover.js')
    // 关键断言：它 resolve 而不是 reject。把「会抛错」当成契约的代码在这里必然错。
    const probe = await probePort(DEAD_PORT, 400)
    expect(probe.reachable).toBe(false)
    expect(probe.isCorum).toBe(false)
  })
})
