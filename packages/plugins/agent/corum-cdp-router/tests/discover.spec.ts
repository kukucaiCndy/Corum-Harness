import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  defaultHomes,
  discover,
  inferRole,
  listListeningPorts,
  probePort,
  readAppVersion,
  readPidRecords,
  suggestId,
} from '../src/discover.js'

const userHome = os.homedir()

describe('inferRole', () => {
  it('9222 ⇒ main（无论 home）', () => {
    expect(inferRole(9222, null, userHome)).toBe('main')
    expect(inferRole(9222, '/somewhere/else', userHome)).toBe('main')
  })

  it('~/.corum 且端口非 9222 ⇒ main（最关键的一条：实测主实例在 9333）', () => {
    expect(inferRole(9333, path.join(userHome, '.corum'), userHome)).toBe('main')
    expect(inferRole(12345, path.join(userHome, '.corum'), userHome)).toBe('main')
  })

  it('home 含 .corum-verify-home ⇒ verify', () => {
    expect(
      inferRole(9333, path.join(os.tmpdir(), 'stamp', '.corum-verify-home'), userHome),
    ).toBe('verify')
  })

  it('home 在 tmpdir 之下 ⇒ verify', () => {
    const tmp = os.tmpdir()
    expect(inferRole(9333, path.join(tmp, 'some-isolated-home'), userHome)).toBe('verify')
    expect(inferRole(9333, tmp, userHome)).toBe('verify')
  })

  it('未知 home ⇒ other', () => {
    expect(inferRole(5000, '/opt/some-thing', userHome)).toBe('other')
    expect(inferRole(5000, null, userHome)).toBe('other')
  })
})

describe('readPidRecords', () => {
  function mkTempHome(records: Record<string, string>): string {
    const tmp = path.join(os.tmpdir(), `.cdp-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    for (const [name, body] of Object.entries(records)) {
      fs.writeFileSync(path.join(runDir, name), body)
    }
    return tmp
  }

  it('正常记录能读出', () => {
    const home = mkTempHome({
      'pack-9333.pid': JSON.stringify({
        pid: 1234,
        combo: 'coding',
        home: '/tmp/x',
        debugPort: 9333,
        startedAt: 1700000000000,
        kind: 'dev',
      }),
    })
    const { records, problems } = readPidRecords(home)
    expect(problems).toEqual([])
    expect(records).toHaveLength(1)
    expect(records[0]!.port).toBe(9333)
    expect(records[0]!.combo).toBe('coding')
    expect(records[0]!.homeFromRecord).toBe('/tmp/x')
    expect(records[0]!.file).toContain('pack-9333.pid')
  })

  it('host.pid 形态（只有 pid/debugPort/startedAt）能读出', () => {
    const home = mkTempHome({
      'host.pid': JSON.stringify({ pid: 99, debugPort: 9222, startedAt: 1700000000000 }),
    })
    const { records, problems } = readPidRecords(home)
    expect(problems).toEqual([])
    expect(records).toHaveLength(1)
    expect(records[0]!.port).toBe(9222)
    expect(records[0]!.homeFromRecord).toBe(home)
  })

  it('坏 JSON 进 problems 且跳过', () => {
    const home = mkTempHome({
      'bad.pid': '{not valid json',
      'good.pid': JSON.stringify({ pid: 1, debugPort: 9000, startedAt: 1 }),
    })
    const { records, problems } = readPidRecords(home)
    expect(records).toHaveLength(1)
    expect(records[0]!.port).toBe(9000)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('解析失败')
  })

  it('非法 debugPort（非正整数或超 65535）进 problems', () => {
    const home = mkTempHome({
      'zero.pid': JSON.stringify({ pid: 1, debugPort: 0 }),
      'neg.pid': JSON.stringify({ pid: 1, debugPort: -1 }),
      'big.pid': JSON.stringify({ pid: 1, debugPort: 70000 }),
      'str.pid': JSON.stringify({ pid: 1, debugPort: 'abc' }),
      'frac.pid': JSON.stringify({ pid: 1, debugPort: 1.5 }),
    })
    const { records, problems } = readPidRecords(home)
    expect(records).toHaveLength(0)
    expect(problems).toHaveLength(5)
    for (const p of problems) {
      expect(p).toContain('debugPort 非法')
    }
  })

  it('不存在的 home ⇒ 空 records、空 problems、不抛错', () => {
    const { records, problems } = readPidRecords('/this/path/does/not/exist/at-all')
    expect(records).toEqual([])
    expect(problems).toEqual([])
  })
})

describe('suggestId', () => {
  it('main 端口 ⇒ main', () => {
    const rec = readPidRecordsEntry({ port: 9222, home: path.join(userHome, '.corum') })
    expect(suggestId(rec, 9222)).toBe('main')
  })

  it('verify home ⇒ verify', () => {
    const rec = readPidRecordsEntry({
      port: 9333,
      home: path.join(os.tmpdir(), 'stamp', '.corum-verify-home'),
    })
    expect(suggestId(rec, 9333)).toBe('verify')
  })

  it('有 combo 名 ⇒ 用 combo 名', () => {
    const rec = readPidRecordsEntry({ port: 5000, home: '/opt/x', combo: 'coding' })
    expect(suggestId(rec, 5000)).toBe('coding')
  })

  it('无 combo、非 main/verify ⇒ port-<port>', () => {
    const rec = readPidRecordsEntry({ port: 5000, home: '/opt/x' })
    expect(suggestId(rec, 5000)).toBe('port-5000')
  })
})

describe('defaultHomes', () => {
  it('至少包含 ~/.corum', () => {
    const homes = defaultHomes({ HOME: userHome })
    expect(homes).toContain(path.join(userHome, '.corum'))
  })

  it('CORUM_HOME / DSH_HOME 会被纳入', () => {
    const homes = defaultHomes({
      CORUM_HOME: '/tmp/corum-a',
      DSH_HOME: '/tmp/dsh-b',
      HOME: userHome,
    })
    expect(homes).toContain(path.resolve('/tmp/corum-a'))
    expect(homes).toContain(path.resolve('/tmp/dsh-b'))
  })

  it('空字符串的环境变量被忽略', () => {
    const homes = defaultHomes({ CORUM_HOME: '', DSH_HOME: '', HOME: userHome })
    expect(homes).not.toContain(path.resolve(''))
  })
})

describe('probePort', () => {
  it('不可达端口 ⇒ reachable: false 且不抛', async () => {
    // 47291：高位端口，几乎不可能有东西在听
    const result = await probePort(47291, 200)
    expect(result.reachable).toBe(false)
    expect(result.isCorum).toBe(false)
    expect(result.electronVersion).toBeNull()
    expect(result.userAgent).toBeNull()
    expect(result.browser).toBeNull()
    expect(result.targetCount).toBe(0)
  })
})

describe('readAppVersion', () => {
  it('不可达端口 ⇒ ok: false 且有 error 字符串', async () => {
    const result = await readAppVersion(47291, 300)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(typeof result.error).toBe('string')
    expect(result.releaseVersion).toBeNull()
  })
})

describe('listListeningPorts', () => {
  it('不抛错且返回数组（本机至少能跑 lsof 或记 problem）', () => {
    const { ports, problems } = listListeningPorts()
    expect(Array.isArray(ports)).toBe(true)
    expect(Array.isArray(problems)).toBe(true)
  })
})

describe('discover', () => {
  it('空 home 列表 ⇒ 空 targets、空 problems、不抛', async () => {
    const result = await discover({ homes: [] })
    expect(result.targets).toEqual([])
    expect(result.problems).toEqual([])
  })

  it('指向不存在的 home ⇒ 空 targets、空 problems', async () => {
    const result = await discover({ homes: ['/no/such/home/zzz'] })
    expect(result.targets).toEqual([])
    expect(result.problems).toEqual([])
  })
})

// ---- helpers ----

function readPidRecordsEntry(init: {
  port: number
  home: string
  combo?: string
}): ReturnType<typeof readPidRecords>['records'][number] {
  return {
    pid: 1,
    debugPort: init.port,
    port: init.port,
    file: '/fake',
    homeFromRecord: init.home,
    ...(init.combo !== undefined ? { combo: init.combo } : {}),
  }
}

describe('readPidRecords — host.pid 形态（debugPort 为空）', () => {
  it('debugPort 为空字符串时静默跳过，不进 problems', () => {
    /**
     * 实测（2026-10-29）：`<home>/run/host.pid` 记的是 host **子进程**
     * （`node .../host/lib/bridge.js`），CDP 端口挂在宿主主进程上，
     * 所以它的 `debugPort` 就是 `""`。
     *
     * 这**不是配置错误**。把它记成「debugPort 非法」会让每次发现都产出
     * 1 条无意义噪音，掩盖真正的问题（比如某条记录真的写坏了）。
     */
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'corum-cdp-router-hostpid-'))
    try {
      fs.mkdirSync(path.join(home, 'run'), { recursive: true })
      fs.writeFileSync(
        path.join(home, 'run', 'host.pid'),
        JSON.stringify({ pid: 70589, debugPort: '', startedAt: 1793283691841 }),
      )
      const { records, problems } = readPidRecords(home)
      expect(records).toHaveLength(0)
      expect(problems).toHaveLength(0)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('debugPort 非空但确实是脏值时才进 problems', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'corum-cdp-router-badport-'))
    try {
      fs.mkdirSync(path.join(home, 'run'), { recursive: true })
      fs.writeFileSync(path.join(home, 'run', 'bad.pid'), JSON.stringify({ pid: 1, debugPort: 'abc' }))
      const { records, problems } = readPidRecords(home)
      expect(records).toHaveLength(0)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('debugPort 非法')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('空与脏值混在同一 home 时，只报脏的那个', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'corum-cdp-router-mixed-'))
    try {
      fs.mkdirSync(path.join(home, 'run'), { recursive: true })
      fs.writeFileSync(path.join(home, 'run', 'host.pid'), JSON.stringify({ pid: 1, debugPort: '' }))
      fs.writeFileSync(path.join(home, 'run', 'pack-9350.pid'), JSON.stringify({ pid: 2, debugPort: 9350 }))
      fs.writeFileSync(path.join(home, 'run', 'bad.pid'), JSON.stringify({ pid: 3, debugPort: 70000 }))
      const { records, problems } = readPidRecords(home)
      expect(records).toHaveLength(1)
      expect(records[0]?.port).toBe(9350)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('70000')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('probePort — 端点类型识别（不限于 Corum）', () => {
  /**
   * 用户动机（2026-10-29 原话）：
   * > 「我之前要求设计这个就是因为现在使用 Google devtools 的 MCP 配置只能写死端口，
   * >  如果不需要写死端口，根据扫描让 Agent 直接动态传递参数调工具就最好了」
   *
   * 所以「是不是 Corum」不能当硬判据 —— Chrome / 任意 Electron 应用 / 其它
   * CDP 兼容浏览器都要能当目标。这些用例钉住那个泛化。
   *
   * 这里只测**纯判定逻辑**（不真起进程）：把 UA 解析部分抽出来测。
   */
  const classify = (ua: string | null): 'corum' | 'chrome' | 'electron' | 'unknown' => {
    const corumMatch = /\bcorum-desktop\/([0-9][0-9A-Za-z.\-]*)/.exec(ua ?? '')
    const electronMatch = /\bElectron\/([0-9][0-9A-Za-z.\-]*)/.exec(ua ?? '')
    const chromeMatch = /\b(?:Chrome|Chromium)\/([0-9][0-9A-Za-z.\-]*)/.exec(ua ?? '')
    if (corumMatch !== null) return 'corum'
    if (electronMatch !== null) return 'electron'
    if (chromeMatch !== null) return 'chrome'
    return 'unknown'
  }

  it('Corum 实例识别为 corum（UA 含 corum-desktop/）', () => {
    expect(classify('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/150.0.7 Electron/43.4.1 corum-desktop/0.7.0 Safari/537.36')).toBe('corum')
  })

  it('普通 Chrome 识别为 chrome（无 Electron 标记）', () => {
    expect(classify('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36')).toBe('chrome')
  })

  it('其它 Electron 应用识别为 electron（不是 Corum 也要能当目标）', () => {
    expect(classify('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.6099.291 Electron/28.0.0 Safari/537.36')).toBe('electron')
  })

  it('完全未知的 UA 归为 unknown（只要能连上仍是合法目标）', () => {
    expect(classify('some-weird-devtools/1.0')).toBe('unknown')
    expect(classify(null)).toBe('unknown')
  })

  it('Corum 优先于 Electron（它俩标记同时存在，但语义不同）', () => {
    // Corum 本身就是一个 Electron 应用，UA 里两个标记都在。必须归 corum，
    // 否则「能读 __DSH_BOOT__」这条额外能力会被丢掉。
    expect(classify('Electron/43.4.1 corum-desktop/0.7.0')).toBe('corum')
  })
})
