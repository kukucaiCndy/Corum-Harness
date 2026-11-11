/**
 * GitHub Releases API 查询与解析纯函数。
 * @module corum-update-checker/github-release
 */

import { parseSemVer, gt } from './version-compare.ts'
import {
  matchPlatformAsset,
  type DownloadAsset,
  type LinuxInstallForm,
  type ReleaseAsset,
  type UpdateArch,
  type UpdatePlatform,
} from './platform-asset.ts'

export interface GithubReleaseConfig {
  readonly owner: string
  readonly repo: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
  readonly token?: string
}

export interface ParsedRelease {
  readonly tag: string
  readonly version: string
  readonly releaseUrl: string
  readonly releaseNotes: string | null
  readonly downloadAsset: DownloadAsset | null
  readonly prerelease: boolean
  readonly publishedAt: string | null
}

export interface GithubQueryError {
  readonly kind: 'network-error' | 'http-error' | 'rate-limited' | 'not-found' | 'parse-error'
  readonly message: string
  readonly status?: number
}

export interface FetchResult {
  readonly ok: boolean
  readonly json?: unknown
  readonly error?: GithubQueryError
}

export async function fetchLatestRelease(config: GithubReleaseConfig): Promise<FetchResult> {
  const { owner, repo, timeoutMs = 15000, token } = config
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
  const fetchFn = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: { kind: 'network-error', message: 'global fetch is not available' } }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'corum-update-checker' }
    if (token !== undefined) headers['Authorization'] = `Bearer ${token}`
    const resp = await fetchFn(url, { signal: controller.signal, headers })
    if (!resp.ok) {
      if (resp.status === 404) return { ok: false, error: { kind: 'not-found', message: `no releases found for ${owner}/${repo}`, status: 404 } }
      if (resp.status === 403) {
        const remaining = resp.headers.get('x-ratelimit-remaining')
        if (remaining === '0') return { ok: false, error: { kind: 'rate-limited', message: 'GitHub API rate limit exceeded', status: 403 } }
      }
      return { ok: false, error: { kind: 'http-error', message: `GitHub API returned HTTP ${resp.status}`, status: resp.status } }
    }
    const json = await resp.json()
    return { ok: true, json }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: { kind: 'network-error', message: `request timed out after ${timeoutMs}ms` } }
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: { kind: 'network-error', message: msg } }
  } finally {
    clearTimeout(timer)
  }
}

interface ReleaseJson {
  readonly tag_name?: unknown
  readonly html_url?: unknown
  readonly body?: unknown
  readonly prerelease?: unknown
  readonly published_at?: unknown
  readonly assets?: readonly { readonly name?: unknown; readonly browser_download_url?: unknown; readonly size?: unknown }[]
}

export function parseLatestRelease(
  json: unknown,
  platform: UpdatePlatform,
  arch: UpdateArch,
  installForm?: LinuxInstallForm,
): ParsedRelease | null {
  const data = json as ReleaseJson
  const tag = typeof data?.tag_name === 'string' ? data.tag_name : undefined
  if (tag === undefined) return null
  const version = tag.startsWith('v') || tag.startsWith('V') ? tag.slice(1) : tag
  const assets: readonly ReleaseAsset[] = Array.isArray(data?.assets)
    ? (data.assets.map(a => ({
        name: typeof a?.name === 'string' ? a.name : '',
        browser_download_url: typeof a?.browser_download_url === 'string' ? a.browser_download_url : '',
        size: typeof a?.size === 'number' ? a.size : 0,
      })).filter(a => a.name !== '') as ReleaseAsset[])
    : []
  const downloadAsset = matchPlatformAsset(assets, platform, arch, version, installForm)
  const releaseUrl = typeof data?.html_url === 'string' ? data.html_url : `https://github.com/kukucaiCndy/Corum-Harness/releases`
  const releaseNotes = typeof data?.body === 'string' ? data.body : null
  const prerelease = typeof data?.prerelease === 'boolean' ? data.prerelease : false
  const publishedAt = typeof data?.published_at === 'string' ? data.published_at : null
  return { tag, version, releaseUrl, releaseNotes, downloadAsset, prerelease, publishedAt }
}

export function isUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  const cur = parseSemVer(currentVersion)
  const lat = parseSemVer(latestVersion)
  if (cur === null || lat === null) return false
  return gt(lat, cur)
}
