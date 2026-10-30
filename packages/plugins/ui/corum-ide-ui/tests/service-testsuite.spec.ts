/**
 * LayoutController 测试中心 chrome 状态测试。
 *
 * 钉死两条契约（service.ts 的 setTestSuiteOpen / toggleTestSuite）：
 *   ① setTestSuiteOpen 幂等：同值不重复广播；
 *   ② toggle 互斥：打开测试中心自动关闭集成中心，反之亦然——同一时刻
 *      只有一个全屏工作面（integrationsOpen / testSuiteOpen 不可同时 true）。
 */
import { describe, expect, it } from 'vitest'
import { LayoutController } from '../src/client/service.ts'

describe('LayoutController — test-suite chrome state', () => {
  it('setTestSuiteOpen(true) opens test suite', () => {
    const lc = new LayoutController()
    lc.setTestSuiteOpen(true)
    expect(lc.getChrome().testSuiteOpen).toBe(true)
  })

  it('setTestSuiteOpen is idempotent (same value does not re-broadcast)', () => {
    const lc = new LayoutController()
    let calls = 0
    lc.chromeSnapshot().subscribe(() => { calls++ })

    lc.setTestSuiteOpen(true)   // true → broadcast (1)
    lc.setTestSuiteOpen(true)   // same → no broadcast
    lc.setTestSuiteOpen(false)  // false → broadcast (2)
    lc.setTestSuiteOpen(false)  // same → no broadcast

    expect(lc.getChrome().testSuiteOpen).toBe(false)
    expect(calls).toBe(2)
  })

  it('toggleTestSuite flips test suite open state', () => {
    const lc = new LayoutController()
    expect(lc.getChrome().testSuiteOpen).toBe(false)
    lc.toggleTestSuite()
    expect(lc.getChrome().testSuiteOpen).toBe(true)
    lc.toggleTestSuite()
    expect(lc.getChrome().testSuiteOpen).toBe(false)
  })

  it('opening test suite mutually closes integrations', () => {
    const lc = new LayoutController()
    lc.setIntegrationsOpen(true)
    expect(lc.getChrome().integrationsOpen).toBe(true)
    expect(lc.getChrome().testSuiteOpen).toBe(false)

    lc.setTestSuiteOpen(true)
    expect(lc.getChrome().testSuiteOpen).toBe(true)
    expect(lc.getChrome().integrationsOpen).toBe(false)
  })

  it('opening integrations mutually closes test suite', () => {
    const lc = new LayoutController()
    lc.setTestSuiteOpen(true)
    expect(lc.getChrome().testSuiteOpen).toBe(true)
    expect(lc.getChrome().integrationsOpen).toBe(false)

    lc.setIntegrationsOpen(true)
    expect(lc.getChrome().integrationsOpen).toBe(true)
    expect(lc.getChrome().testSuiteOpen).toBe(false)
  })

  it('toggleTestSuite closes integrations when opening', () => {
    const lc = new LayoutController()
    lc.setIntegrationsOpen(true)

    lc.toggleTestSuite() // opens test suite ⇒ integrations must close
    expect(lc.getChrome().testSuiteOpen).toBe(true)
    expect(lc.getChrome().integrationsOpen).toBe(false)
  })

  it('integrationsOpen and testSuiteOpen are never both true', () => {
    const lc = new LayoutController()
    // Try every combination of toggle calls — invariant must hold.
    lc.toggleIntegrations()   // integrations=true, test=false
    expect(lc.getChrome().integrationsOpen).toBe(true)
    expect(lc.getChrome().testSuiteOpen).toBe(false)

    lc.toggleTestSuite()      // test=true, integrations=false (mutex)
    expect(lc.getChrome().testSuiteOpen).toBe(true)
    expect(lc.getChrome().integrationsOpen).toBe(false)

    lc.toggleIntegrations()   // integrations=true, test=false (mutex)
    expect(lc.getChrome().integrationsOpen).toBe(true)
    expect(lc.getChrome().testSuiteOpen).toBe(false)
  })

  it('closing test suite does not open integrations', () => {
    const lc = new LayoutController()
    lc.setTestSuiteOpen(true)
    lc.setTestSuiteOpen(false)
    expect(lc.getChrome().testSuiteOpen).toBe(false)
    expect(lc.getChrome().integrationsOpen).toBe(false)
  })
})
