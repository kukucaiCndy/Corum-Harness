/**
 * 轻量 semver 比较纯函数 —— 不引入新依赖。
 * @module corum-update-checker/version-compare
 */

export interface SemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (number | string)[]
}

export function parseSemVer(raw: string): SemVer | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const core = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
  // semver 规范：`+` 后是 build metadata，不参与比较——先剥掉它。
  const plusIdx = core.indexOf('+')
  const withoutBuild = plusIdx >= 0 ? core.slice(0, plusIdx) : core
  const dashIdx = withoutBuild.indexOf('-')
  const versionPart = dashIdx >= 0 ? withoutBuild.slice(0, dashIdx) : withoutBuild
  const prereleasePart = dashIdx >= 0 ? withoutBuild.slice(dashIdx + 1) : ''
  const segments = versionPart.split('.')
  if (segments.length !== 3) return null
  const major = Number(segments[0])
  const minor = Number(segments[1])
  const patch = Number(segments[2])
  if (!Number.isInteger(major) || segments[0] === '') return null
  if (!Number.isInteger(minor) || segments[1] === '') return null
  if (!Number.isInteger(patch) || segments[2] === '') return null
  if (major < 0 || minor < 0 || patch < 0) return null
  let prerelease: (number | string)[] = []
  if (prereleasePart !== '') {
    prerelease = prereleasePart.split('.').map(seg => /^\d+$/.test(seg) ? Number(seg) : seg)
  }
  return { major, minor, patch, prerelease }
}

function comparePrereleaseIdentifiers(a: number | string, b: number | string): number {
  const aIsNum = typeof a === 'number'
  const bIsNum = typeof b === 'number'
  if (aIsNum && bIsNum) return (a as number) - (b as number)
  if (aIsNum && !bIsNum) return -1
  if (!aIsNum && bIsNum) return 1
  const aStr = a as string
  const bStr = b as string
  if (aStr < bStr) return -1
  if (aStr > bStr) return 1
  return 0
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  const aHas = a.prerelease.length > 0
  const bHas = b.prerelease.length > 0
  if (!aHas && !bHas) return 0
  if (!aHas && bHas) return 1
  if (aHas && !bHas) return -1
  const len = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i++) {
    const cmp = comparePrereleaseIdentifiers(a.prerelease[i], b.prerelease[i])
    if (cmp !== 0) return cmp
  }
  return a.prerelease.length - b.prerelease.length
}

export function gt(a: SemVer, b: SemVer): boolean { return compareSemVer(a, b) > 0 }
export function gte(a: SemVer, b: SemVer): boolean { return compareSemVer(a, b) >= 0 }

export function compareVersionStrings(a: string, b: string): number {
  const pa = parseSemVer(a)
  const pb = parseSemVer(b)
  if (pa === null || pb === null) return 0
  return compareSemVer(pa, pb)
}
