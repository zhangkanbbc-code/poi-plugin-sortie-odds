import type { DataSource } from './map-cache'

export interface DataMeta {
  source: DataSource
  savedAt: number
}

const SOURCE_RANK: Record<DataSource, number> = {
  network: 0,
  disk: 1,
  snapshot: 2,
  'disk-stale': 3,
}

export const summarizeResources = (resources: DataMeta[]): DataMeta | null => {
  if (resources.length === 0) return null
  return resources.reduce((worst, item) => {
    if (SOURCE_RANK[item.source] > SOURCE_RANK[worst.source]) return item
    if (
      SOURCE_RANK[item.source] === SOURCE_RANK[worst.source]
      && item.savedAt < worst.savedAt
    ) return item
    return worst
  })
}

export const formatDataAge = (savedAt: number, now = Date.now()): string => {
  const diff = Math.max(0, now - savedAt)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  return `${Math.floor(diff / day)} 天前`
}

export const sourceLabel = (meta: DataMeta, now = Date.now()): string => {
  switch (meta.source) {
    case 'network':
      return `KCNav 实时 · ${formatDataAge(meta.savedAt, now)}`
    case 'disk':
      return `本地缓存 · ${formatDataAge(meta.savedAt, now)}`
    case 'disk-stale':
      return `过期缓存 · ${formatDataAge(meta.savedAt, now)}`
    case 'snapshot':
      return `内置快照（${new Date(meta.savedAt).toISOString().slice(0, 10)}）`
  }
}
