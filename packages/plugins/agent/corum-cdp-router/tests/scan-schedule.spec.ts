/**
 * 自动扫描调度 —— 开关与间隔真的作用于定时器。
 *
 * 用户原始诉求：「增加一个自动扫描开关和间隔设置，用户可以关闭并设置扫描间隔」。
 * 所以这里测的不是「配置能存下来」，而是**关掉后定时器真的不挂**、**间隔真的传给
 * `setInterval`**、以及**间隔原样透传**（不被夹取或取整）。
 *
 * 为什么不 new 一个 CdpRouterService 来测：它继承 `TypertRemoteService`，构造必须
 * 落在真实 cordis 上下文里（`super(ctx, 'cdpRouter')` 会去 store 上注册）。把调度
 * 决策抽成 `resolveScanSchedule` 这个纯函数，才能在不搭整套宿主的前提下测到真行为。
 */

import { describe, expect, it } from 'vitest'

import { resolveScanSchedule } from '../src/index.js'
import type { CdpTargetsConfig } from '../src/targets.js'

/** 造一份最小配置（不碰磁盘）。 */
function config(over: Partial<CdpTargetsConfig> = {}): CdpTargetsConfig {
  return {
    version: 1,
    autoDiscover: true,
    scanIntervalMs: 60_000,
    targets: [],
    ...over,
  }
}

describe('resolveScanSchedule', () => {
  it('开关关闭 ⇒ 不挂定时器、不做启动扫描（关掉就该真关掉）', () => {
    expect(resolveScanSchedule(config({ autoDiscover: false }))).toEqual({
      intervalMs: null,
      scanImmediately: false,
    })
  })

  it('开关打开 ⇒ 用配置里的间隔，并且先扫一次', () => {
    expect(resolveScanSchedule(config({ scanIntervalMs: 45_000 }))).toEqual({
      intervalMs: 45_000,
      scanImmediately: true,
    })
  })

  it('间隔原样透传，不被夹取或取整成别的值', () => {
    for (const ms of [30_000, 90_000, 3_600_000]) {
      expect(resolveScanSchedule(config({ scanIntervalMs: ms })).intervalMs).toBe(ms)
    }
  })
})
