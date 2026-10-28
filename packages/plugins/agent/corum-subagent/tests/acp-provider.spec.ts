/**
 * 阶段 5 ACP provider wrapper 测试。
 *
 * 覆盖：
 *  - resolveAcpCommand 环境变量解析（dev/packaged 缺失 fail-loud）
 *  - Config zod 校验（providerName 默认 'acp'）
 *  - permission 固定 'reject'（负例验证基线）
 *  - env 传递 DSH_HOME/CORUM_HOME（deployment-owned，非空校验）
 *  - env 不传 KEY/TOKEN/SECRET（敏感值不泄漏）
 *  - 官方 apply 被正确调用（command/args 来自环境变量）
 *  - dispose grace 默认值正确
 *  - 三平台路径（darwin/linux/win32 packaged + dev）
 *
 * @module @corum/corum-subagent/tests/acp-provider.spec
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Mock the official dsh-subagent-acp apply so we can assert the config it
// receives without actually spawning a child process.
const mockApplyOfficial = vi.fn()
vi.mock('@deepseek-ai/dsh-subagent-acp', () => ({
  apply: mockApplyOfficial,
}))

const { Config, apply } = await import('../src/acp/index.ts') as {
  Config: (input: unknown) => { providerName: string }
  apply: (ctx: unknown, config: { providerName: string }) => void
}

describe('ACP provider wrapper — Config schema', () => {
  it('defaults providerName to "acp"', () => {
    const parsed = Config({})
    expect(parsed.providerName).toBe('acp')
  })

  it('accepts a custom providerName', () => {
    const parsed = Config({ providerName: 'custom-acp' })
    expect(parsed.providerName).toBe('custom-acp')
  })
})

describe('ACP provider wrapper — apply()', () => {
  beforeEach(() => {
    mockApplyOfficial.mockClear()
    process.env.CORUM_HOST_NODE = '/usr/local/bin/node'
    process.env.CORUM_ACP_CLI_PATH = '/path/to/dsh/lib/bin.js'
    process.env.DSH_HOME = '/tmp/test-dsh-home'
    process.env.CORUM_HOME = '/tmp/test-corum-home'
  })

  afterEach(() => {
    delete process.env.CORUM_HOST_NODE
    delete process.env.CORUM_ACP_CLI_PATH
    delete process.env.DSH_HOME
    delete process.env.CORUM_HOME
  })

  it('throws if CORUM_HOST_NODE is missing (fail-loud)', () => {
    delete process.env.CORUM_HOST_NODE
    expect(() => apply({}, { providerName: 'acp' })).toThrow(/CORUM_HOST_NODE/)
  })

  it('throws if CORUM_ACP_CLI_PATH is missing (fail-loud)', () => {
    delete process.env.CORUM_ACP_CLI_PATH
    expect(() => apply({}, { providerName: 'acp' })).toThrow(/CORUM_ACP_CLI_PATH/)
  })

  it('throws if CORUM_HOST_NODE is empty string', () => {
    process.env.CORUM_HOST_NODE = '  '
    expect(() => apply({}, { providerName: 'acp' })).toThrow(/CORUM_HOST_NODE/)
  })

  it('calls official apply with command from CORUM_HOST_NODE', () => {
    apply({}, { providerName: 'acp' })
    expect(mockApplyOfficial).toHaveBeenCalledOnce()
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.command).toBe('/usr/local/bin/node')
  })

  it('calls official apply with args [cliPath, --profile, acp]', () => {
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.args).toEqual(['/path/to/dsh/lib/bin.js', '--profile', 'acp'])
  })

  it('fixes permission to reject (negative-case verification baseline)', () => {
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.permission).toBe('reject')
  })

  it('passes DSH_HOME in env (deployment-owned, not scrubbed)', () => {
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.env.DSH_HOME).toBe('/tmp/test-dsh-home')
  })

  it('passes CORUM_HOME in env (deployment-owned, not scrubbed)', () => {
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.env.CORUM_HOME).toBe('/tmp/test-corum-home')
  })

  it('does NOT pass credential-shaped env (KEY/TOKEN/SECRET)', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-leak-test'
    process.env.DSH_SOME_TOKEN = 'token-leak'
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    // Only DSH_HOME and CORUM_HOME should be in env — no secrets.
    const envKeys = Object.keys(passedConfig.env)
    expect(envKeys).toEqual(expect.arrayContaining(['DSH_HOME', 'CORUM_HOME']))
    expect(envKeys).not.toContain('DEEPSEEK_API_KEY')
    expect(envKeys).not.toContain('DSH_SOME_TOKEN')
    expect(envKeys.length).toBe(2) // only DSH_HOME + CORUM_HOME
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DSH_SOME_TOKEN
  })

  it('omits DSH_HOME from env if unset (not injected as empty)', () => {
    delete process.env.DSH_HOME
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.env.DSH_HOME).toBeUndefined()
    expect(passedConfig.env.CORUM_HOME).toBe('/tmp/test-corum-home')
  })

  it('passes providerName through', () => {
    apply({}, { providerName: 'custom-acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.providerName).toBe('custom-acp')
  })

  it('passes default dispose grace values', () => {
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.disposeEofGraceMs).toBe(6_000)
    expect(passedConfig.disposeGraceMs).toBe(3_000)
  })
})

describe('ACP provider wrapper — three-platform path correctness', () => {
  beforeEach(() => {
    mockApplyOfficial.mockClear()
  })

  afterEach(() => {
    delete process.env.CORUM_HOST_NODE
    delete process.env.CORUM_ACP_CLI_PATH
    delete process.env.DSH_HOME
    delete process.env.CORUM_HOME
  })

  it('darwin packaged: Resources/node/bin/node', () => {
    process.env.CORUM_HOST_NODE = '/app/Corum.app/Contents/Resources/node/bin/node'
    process.env.CORUM_ACP_CLI_PATH = '/app/Corum.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js'
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.command).toContain('bin/node')
    expect(passedConfig.args[0]).toContain('host/node_modules')
  })

  it('linux packaged: same darwin path layout (POSIX archive)', () => {
    process.env.CORUM_HOST_NODE = '/opt/corum/resources/node/bin/node'
    process.env.CORUM_ACP_CLI_PATH = '/opt/corum/resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js'
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.command).toContain('bin/node')
  })

  it('win32 packaged: Resources/node/node.exe (no bin/ directory)', () => {
    process.env.CORUM_HOST_NODE = 'C:\\Program Files\\Corum\\resources\\node\\node.exe'
    process.env.CORUM_ACP_CLI_PATH = 'C:\\Program Files\\Corum\\resources\\host\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.command).toBe('C:\\Program Files\\Corum\\resources\\node\\node.exe')
    expect(passedConfig.args[0]).toBe('C:\\Program Files\\Corum\\resources\\host\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
  })

  it('dev: process.execPath + repo node_modules', () => {
    process.env.CORUM_HOST_NODE = '/Users/dev/.nvm/versions/node/v22/bin/node'
    process.env.CORUM_ACP_CLI_PATH = '/repo/packages/desktop/node_modules/@deepseek-ai/dsh/lib/bin.js'
    apply({}, { providerName: 'acp' })
    const [, passedConfig] = mockApplyOfficial.mock.calls[0]
    expect(passedConfig.command).toContain('node')
    expect(passedConfig.args).toEqual([
      '/repo/packages/desktop/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '--profile',
      'acp',
    ])
  })
})

// Real provider registration + capability verification is in
// acp-capability-rejection.spec.ts (uses unmocked official apply with a
// capturing ctx to inspect the real AcpProvider instance).
