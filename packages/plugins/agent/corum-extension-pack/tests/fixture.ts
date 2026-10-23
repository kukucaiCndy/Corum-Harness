/**
 * 测试夹具：在临时目录里造一个完整的扩展包（extension.json + presets + skills + mcp）。
 *
 * 所有测试都用 mkdtempSync 建临时目录，不碰真实 ~/.corum。
 * 测试里还会另外建一个临时 home（在 spec 里设进 process.env.CORUM_HOME）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 一个完整的测试扩展包目录（extension.json + presets/alpha + presets/beta +
 * skills/shared-skill + skills/lone-skill + mcp/shared-mcp.json）。
 */
export interface FixturePack {
  /** 临时扩展包目录绝对路径。 */
  readonly dir: string
  /** 扩展包 id（= "test-pack"）。 */
  readonly id: string
  /** presets 名列表（["alpha","beta"]）。 */
  readonly presets: readonly string[]
  /** skills 名列表（["shared-skill","lone-skill"]）。 */
  readonly skills: readonly string[]
  /** mcp 名列表（["shared-mcp"]）。 */
  readonly mcp: readonly string[]
}

/**
 * 造一个合法的测试扩展包目录。
 *
 * 布局：
 *   extension.json    { formatVersion:1, id:"test-pack", version:"1.0.0", name:"Test Pack",
 *                       contents:{ presets:["alpha","beta"], skills:["shared-skill","lone-skill"],
 *                                  mcp:["shared-mcp"] } }
 *   presets/alpha/agent.json   { id,nickname,prompt,skills:[{name:"shared-skill",versionId:""}],
 *                               mcpServers:["shared-mcp"] }
 *   presets/beta/agent.json    同上（也引用 shared-skill/shared-mcp——证明一份技能/MCP
 *                               被多个预设共享时只装一次）
 *   skills/shared-skill/SKILL.md
 *   skills/lone-skill/SKILL.md
 *   mcp/shared-mcp.json        stdio + 合法 requires（validateMcpEntry 强制）
 *
 * @param overrides - 可覆盖 id / presets / skills / mcp 名字。
 * @returns 见 {@link FixturePack}。
 */
export function makeFixturePack(overrides?: Partial<FixturePack>): FixturePack {
  const dir = mkdtempSync(join(tmpdir(), 'corum-extension-pack-src-'))

  const id = overrides?.id ?? 'test-pack'
  const presets = overrides?.presets ?? ['alpha', 'beta']
  const skills = overrides?.skills ?? ['shared-skill', 'lone-skill']
  const mcp = overrides?.mcp ?? ['shared-mcp']

  // extension.json
  writeFileSync(join(dir, 'extension.json'), JSON.stringify({
    formatVersion: 1,
    id,
    version: '1.0.0',
    name: 'Test Pack',
    contents: { presets, skills, mcp },
  }, null, 2), 'utf8')

  // presets/<name>/agent.json —— 每个都引用 shared-skill + shared-mcp（证明共享实体只装一次）。
  const sharedSkill = skills[0] ?? 'shared-skill'
  const sharedMcp = mcp[0] ?? 'shared-mcp'
  for (const name of presets) {
    const presetDir = join(dir, 'presets', name)
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'agent.json'), JSON.stringify({
      id: name,
      nickname: `${name} Agent`,
      baseMode: 'standard',
      prompt: `你是 ${name} 测试 Agent`,
      skills: [{ name: sharedSkill, versionId: '' }],
      mcpServers: [sharedMcp],
    }, null, 2), 'utf8')
  }

  // skills/<name>/SKILL.md
  for (const name of skills) {
    const skillDir = join(dir, 'skills', name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---\ndescription: ${name}\n---\n# ${name}\n`, 'utf8')
  }

  // mcp/<name>.json —— 必须带合法 requires（validateMcpEntry 强制）。
  mkdirSync(join(dir, 'mcp'), { recursive: true })
  for (const name of mcp) {
    writeFileSync(join(dir, 'mcp', `${name}.json`), JSON.stringify({
      name,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', `@test/${name}`],
      requires: { kind: 'command', command: 'npx', hint: '运行 npx --version' },
    }, null, 2), 'utf8')
  }

  return { dir, id, presets, skills, mcp }
}

/**
 * 造一个空 home（没有任何预设/技能/MCP 注册表）。
 *
 * 测试 spec 在 beforeEach 里把它设进 process.env.CORUM_HOME，并在 afterEach 还原。
 */
export function makeEmptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'corum-extension-pack-home-'))
}
