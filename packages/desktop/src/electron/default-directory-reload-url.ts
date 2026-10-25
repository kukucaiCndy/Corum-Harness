export interface DefaultDirectoryReloadOptions { notice: 'migrated' | 'restored' }
export function defaultDirectoryReloadUrl(url: string, options?: DefaultDirectoryReloadOptions): string {
  if (options?.notice !== 'migrated' && options?.notice !== 'restored') return url
  const target = new URL(url)
  target.hash = `corum-default-directory=${options.notice}`
  return target.href
}
