/**
 * 扫描设置的规范化与调度决策。
 *
 * 用户原始诉求：「增加一个自动扫描开关和间隔设置，用户可以关闭并设置扫描间隔」。
 * 所以这里测的是「关掉后真的不挂定时器」「间隔原样透传」，而不是「配置能存下来」。
 *
 * ## 为什么这些判据住在纯函数里
 *
 * 真实调度挂在 `TypertRemoteService` 上，构造必须落在真实 cordis 上下文里
 * （`super(ctx, 'cdpRouter')` 会去 store 注册）。把决策抽成纯函数，才能在不搭
 * 整套宿主的前提下测到真行为。
 *
 * ## 存放位置的变更（2026-11-03）
 *
 * 这些设置原本写在 `cdp-targets.json` 的顶层 `scanIntervalMs`。实测发现旧版
 * cdp-router 对未知顶层键 **fail loud** ⇒ 新版写过一次，旧版就读不出整份配置
 * （连 targets 一起失效）。故搬进 settings 命名空间，本文件的用例随之改成
 * 直接测 `ScanSettings` 形状（不再经过配置文件）。
 */

import { describe, expect, it } from 'vitest'

import {
  SCAN_INTERVAL_MAX_MS,
  SCAN_INTERVAL_MIN_MS,
  SCAN_SETTINGS_DEFAULT,
  normalizeInterval,
  normalizeScanSettings,
  resolveScanSchedule,
} from '../src/scan-settings.js'

describe('resolveScanSchedule', () => {
  it('开关关闭 ⇒ 不挂定时器、不做启动扫描（关掉就该真关掉）', () => {
    expect(resolveScanSchedule({ autoScan: false, scanIntervalMs: 60_000 })).toEqual({
      intervalMs: null,
      scanImmediately: false,
    })
  })

  it('开关打开 ⇒ 用设置里的间隔，并且先扫一次', () => {
    expect(resolveScanSchedule({ autoScan: true, scanIntervalMs: 45_000 })).toEqual({
      intervalMs: 45_000,
      scanImmediately: true,
    })
  })

  it('间隔原样透传，不被夹取或取整成别的值', () => {
    for (const ms of [SCAN_INTERVAL_MIN_MS, 90_000, SCAN_INTERVAL_MAX_MS]) {
      expect(resolveScanSchedule({ autoScan: true, scanIntervalMs: ms }).intervalMs).toBe(ms)
    }
  })
})

describe('normalizeInterval', () => {
  it('区间内的整数原样保留', () => {
    expect(normalizeInterval(45_000)).toBe(45_000)
    expect(normalizeInterval(SCAN_INTERVAL_MIN_MS)).toBe(SCAN_INTERVAL_MIN_MS)
    expect(normalizeInterval(SCAN_INTERVAL_MAX_MS)).toBe(SCAN_INTERVAL_MAX_MS)
  })

  /**
   * 越界与非整数**回落默认值而不是抛错**：这个值来自设置面或旧配置，
   * 让它把插件搞崩不值得；扫描频率错了顶多不准，不会破坏数据。
   */
  it('越界 / 非整数 / 非数字 ⇒ 回落默认值，不抛错', () => {
    for (const bad of [0, -1, 1.5, SCAN_INTERVAL_MIN_MS - 1, SCAN_INTERVAL_MAX_MS + 1, '60000', null, undefined]) {
      expect(normalizeInterval(bad), `normalizeInterval(${JSON.stringify(bad)})`).toBe(
        SCAN_SETTINGS_DEFAULT.scanIntervalMs,
      )
    }
  })
})

describe('normalizeScanSettings', () => {
  it('缺字段各自回落默认值', () => {
    expect(normalizeScanSettings({})).toEqual(SCAN_SETTINGS_DEFAULT)
    expect(normalizeScanSettings(null)).toEqual(SCAN_SETTINGS_DEFAULT)
    expect(normalizeScanSettings({ autoScan: false })).toEqual({
      autoScan: false,
      scanIntervalMs: SCAN_SETTINGS_DEFAULT.scanIntervalMs,
    })
  })

  it('只给合法字段时保留它，非法字段单独回落', () => {
    expect(normalizeScanSettings({ autoScan: true, scanIntervalMs: 999 })).toEqual({
      autoScan: true,
      scanIntervalMs: SCAN_SETTINGS_DEFAULT.scanIntervalMs,
    })
  })
})
