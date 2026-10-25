import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

export type DirectoryStorageBackend = 'json' | 'sqlite'
export interface DirectoryStorageSnapshot {
  descriptor: KvUnitDescriptor
  tables: Record<string, Record<string, unknown>>
  global: unknown
}
const descriptors: KvUnitDescriptor[] = [
  { name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true, layout: 'single' },
  { name: 'corum_orchestration', version: 1, tables: ['ledger'], hasGlobal: false, layout: 'per-record' },
  { name: 'session_projcache', version: 7, tables: ['sessions'], hasGlobal: false, layout: 'per-record' },
]
function storage(home: string, backend: DirectoryStorageBackend) {
  return backend === 'sqlite' ? new SqliteStorageBackend({ path: join(home, 'storages', 'kv.sqlite'), journalMode: 'wal' }) : new JsonStorageBackend(join(home, 'storages'))
}

/** 通过官方 KV seam 读写，不接触 SQL 或未启用的后端副本。 */
export async function readDirectoryStorage(home: string, backend: DirectoryStorageBackend): Promise<DirectoryStorageSnapshot[]> {
  const medium = storage(home, backend)
  try {
    const snapshots: DirectoryStorageSnapshot[] = []
    for (const descriptor of descriptors) {
      const unit = await medium.kv.open(descriptor)
      try { snapshots.push({ descriptor, ...await unit.loadAll() }) } finally { await unit.close() }
    }
    return snapshots
  } finally { await medium.close() }
}

export async function writeDirectoryStorage(home: string, backend: DirectoryStorageBackend, snapshots: DirectoryStorageSnapshot[]): Promise<void> {
  const medium = storage(home, backend)
  try {
    for (const snapshot of snapshots) {
      const unit = await medium.kv.open(snapshot.descriptor)
      try {
        const old = await unit.loadAll()
        for (const table of snapshot.descriptor.tables) {
          const records = snapshot.tables[table] ?? {}
          for (const key of Object.keys(old.tables[table] ?? {})) if (!(key in records)) await unit.deleteRecord(table, key)
          for (const [key, value] of Object.entries(records)) await unit.putRecord(table, key, value)
        }
        if (snapshot.descriptor.hasGlobal) await unit.setGlobal(snapshot.global)
      } finally { await unit.close() }
    }
  } finally { await medium.close() }
}
