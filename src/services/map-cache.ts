import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type DataSource = 'network' | 'disk' | 'disk-stale' | 'snapshot'

export interface CachedResource<T> {
  value: T
  savedAt: number
  source: DataSource
}

export type ResourceKind = 'map' | 'enemy' | 'evidence'

interface DiskEntry<T> {
  savedAt: number
  value: T
}

export const poiDataPath = typeof window !== 'undefined' && window.APPDATA_PATH
  ? window.APPDATA_PATH
  : join(process.env.APPDATA ?? process.cwd(), 'poi')

export const cacheRoot = join(poiDataPath, 'sortie-odds-cache')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NORMAL_TTL = 30 * DAY
const EVENT_TTL: Record<ResourceKind, number> = {
  map: DAY,
  enemy: 12 * HOUR,
  evidence: DAY,
}

export const isNormalMap = (mapId: string): boolean => {
  const world = Number(mapId.split('-')[0])
  return world > 0 && world < 10
}

export const ttlFor = (mapId: string, kind: ResourceKind): number =>
  isNormalMap(mapId) ? NORMAL_TTL : EVENT_TTL[kind]

const safeMapId = (mapId: string): string =>
  /^\d+-\d+$/.test(mapId) ? mapId : 'invalid'

export interface MapCacheDeps {
  v2Root?: string
  v1Root?: string
  snapshotRoot?: string | null
}

export interface SnapshotManifest {
  generatedAt: number
  maps: string[]
}

export interface MapCache {
  readFresh: <T>(mapId: string, name: string, kind: ResourceKind) => Promise<CachedResource<T> | null>
  readSnapshot: <T>(mapId: string, name: string) => Promise<CachedResource<T> | null>
  readSnapshotManifest: () => Promise<SnapshotManifest | null>
  readStale: <T>(mapId: string, name: string) => Promise<CachedResource<T> | null>
  write: <T>(mapId: string, name: string, value: T, savedAt?: number) => Promise<void>
}

export const createMapCache = (deps: MapCacheDeps = {}): MapCache => {
  const v2Root = deps.v2Root ?? join(cacheRoot, 'maps-v2')
  const v1Root = deps.v1Root ?? join(cacheRoot, 'normal-maps-v1')
  const snapshotRoot = deps.snapshotRoot === undefined
    ? join(__dirname, 'data', 'normal-maps')
    : deps.snapshotRoot
  const memory = new Map<string, DiskEntry<unknown>>()

  const readEntry = async <T>(path: string): Promise<DiskEntry<T> | null> => {
    const cached = memory.get(path) as DiskEntry<T> | undefined
    if (cached) return cached
    try {
      const entry = JSON.parse(await readFile(path, 'utf8')) as DiskEntry<T>
      if (typeof entry?.savedAt !== 'number') return null
      memory.set(path, entry)
      return entry
    } catch {
      return null
    }
  }

  const write = async <T>(
    mapId: string,
    name: string,
    value: T,
    savedAt = Date.now(),
  ): Promise<void> => {
    const path = join(v2Root, safeMapId(mapId), name)
    const entry: DiskEntry<T> = { savedAt, value }
    try {
      await mkdir(join(v2Root, safeMapId(mapId)), { recursive: true })
      await writeFile(path, JSON.stringify(entry), 'utf8')
      memory.set(path, entry)
    } catch {
      // 只读数据目录不阻断在线分析
    }
  }

  const readAny = async <T>(mapId: string, name: string): Promise<DiskEntry<T> | null> => {
    const v2 = await readEntry<T>(join(v2Root, safeMapId(mapId), name))
    if (v2) return v2
    const v1 = await readEntry<T>(join(v1Root, safeMapId(mapId), name))
    if (v1) {
      await write(mapId, name, v1.value, v1.savedAt)
      return v1
    }
    return null
  }

  return {
    readFresh: async <T>(mapId: string, name: string, kind: ResourceKind) => {
      const entry = await readAny<T>(mapId, name)
      if (!entry || Date.now() - entry.savedAt > ttlFor(mapId, kind)) return null
      return { value: entry.value, savedAt: entry.savedAt, source: 'disk' as const }
    },
    readSnapshot: async <T>(mapId: string, name: string) => {
      if (!snapshotRoot || !isNormalMap(mapId)) return null
      const entry = await readEntry<T>(join(snapshotRoot, safeMapId(mapId), name))
      if (!entry) return null
      return { value: entry.value, savedAt: entry.savedAt, source: 'snapshot' as const }
    },
    readSnapshotManifest: async () => {
      if (!snapshotRoot) return null
      try {
        const raw = JSON.parse(
          await readFile(join(snapshotRoot, 'manifest.json'), 'utf8'),
        ) as { generatedAt?: number; maps?: string[] }
        if (typeof raw.generatedAt !== 'number') return null
        return { generatedAt: raw.generatedAt, maps: raw.maps ?? [] }
      } catch {
        return null
      }
    },
    readStale: async <T>(mapId: string, name: string) => {
      const entry = await readAny<T>(mapId, name)
      if (!entry) return null
      return { value: entry.value, savedAt: entry.savedAt, source: 'disk-stale' as const }
    },
    write,
  }
}

export const mapCache = createMapCache()
