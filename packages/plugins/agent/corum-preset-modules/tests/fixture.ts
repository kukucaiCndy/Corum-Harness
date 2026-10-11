/**
 * 测试夹具：在临时目录里造一个完整的 CORUM_HOME 布局（预设/技能/MCP 注册表/头像）。
 *
 * 所有测试都用 mkdtempSync 建临时目录，不碰真实 ~/.corum。
 * 夹具返回的 home 路径**已设进 process.env.CORUM_HOME**（saveServer 读它）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一个完整的测试用 CORUM_HOME（含一个预设、一个技能、两个 MCP 条目、一个头像）。 */
export interface TestHome {
  /** 临时 CORUM_HOME 绝对路径（= process.env.CORUM_HOME）。 */
  home: string
  /** 预设 id。 */
  profileId: string
  /** 技能名（已落盘实体）。 */
  skillName: string
  /** MCP 服务名（已在注册表里）。 */
  mcpName: string
  /** 另一个 MCP（带合法 requires）。 */
  mcpWithRequiresName: string
}

/**
 * 造一个测试 home：预设 agent.json + 一个技能 + mcp-servers.json + 头像 dataURL。
 *
 * @param overrides - 可覆盖 profileId / mcpName 等。
 * @returns 见 {@link TestHome}。
 */
export function makeTestHome(overrides?: Partial<TestHome>): TestHome {
  const home = mkdtempSync(join(tmpdir(), 'corum-preset-modules-test-'))
  process.env.CORUM_HOME = home

  const profileId = overrides?.profileId ?? 'test-agent'
  const skillName = overrides?.skillName ?? 'test-skill'
  const mcpName = overrides?.mcpName ?? 'test-mcp'
  const mcpWithRequiresName = overrides?.mcpWithRequiresName ?? 'mcp-with-requires'

  // 预设目录 + agent.json。
  const profileDir = join(home, '.agent-presets', profileId)
  mkdirSync(profileDir, { recursive: true })
  // 头像用 1x1 透明 PNG 的 dataURL。
  const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const profile = {
    id: profileId,
    nickname: '测试 Agent',
    baseMode: 'standard',
    prompt: '你是一个测试 Agent',
    model: { provider: 'test', model: 'test-model' },
    skills: [{ name: skillName, versionId: '' }],
    mcpServers: [mcpName, mcpWithRequiresName],
    terminal: { mode: 'sandbox' as const },
    memoryPolicy: { scope: 'none' as const },
    version: 1,
    trust: 'user' as const,
    avatar: avatarDataUrl,
  }
  writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')

  // 技能目录 + SKILL.md。
  const skillDir = join(home, 'skills', skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: 测试技能\n---\n# 测试技能\n', 'utf8')

  // MCP 注册表：test-mcp 没 requires（应被 blocked）；mcp-with-requires 有合法 requires。
  const registry = {
    servers: [
      {
        name: mcpName,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@test/mcp-server'],
      },
      {
        name: mcpWithRequiresName,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@test/another-mcp'],
        requires: {
          kind: 'command' as const,
          command: 'npx',
          hint: '运行 `npx --version` 验证已安装',
        },
      },
    ],
  }
  writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify(registry, null, 2), 'utf8')

  return { home, profileId, skillName, mcpName, mcpWithRequiresName }
}

/** 清理：还原 process.env.CORUM_HOME（vitest afterEach 调）。 */
export function restoreHome(savedEnv: string | undefined): void {
  if (savedEnv === undefined) {
    delete process.env.CORUM_HOME
  } else {
    process.env.CORUM_HOME = savedEnv
  }
}
