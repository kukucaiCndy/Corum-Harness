import { createContext } from 'react'
export type DefaultDirectoryNotice = 'migrated' | 'restored'
export const DefaultDirectoryNoticeContext = createContext<DefaultDirectoryNotice | null>(null)
export function consumeDefaultDirectoryResume(location: Pick<Location, 'hash' | 'href'>, history: Pick<History, 'state' | 'replaceState'>): DefaultDirectoryNotice | null {
  const notice = location.hash.slice('#corum-default-directory='.length)
  if (!location.hash.startsWith('#corum-default-directory=') || (notice !== 'migrated' && notice !== 'restored')) return null
  const url = new URL(location.href)
  url.hash = ''
  history.replaceState(history.state, '', url.href)
  return notice
}
