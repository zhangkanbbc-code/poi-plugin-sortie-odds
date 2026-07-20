import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMapCache, ttlFor } from '../src/services/map-cache'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const makeRoots = async () => {
  const base = await mkdtemp(join(tmpdir(), 'sortie-odds-cache-'))
  return {
    v2Root: join(base, 'maps-v2'),
    v1Root: join(base, 'normal-maps-v1'),
    snapshotRoot: join(base, 'snapshot'),
  }
}

const writeEntry = async (
  root: string,
  mapId: string,
  name: string,
  savedAt: number,
  value: unknown,
) => {
  await mkdir(join(root, mapId), { recursive: true })
  await writeFile(join(root, mapId, name), JSON.stringify({ savedAt, value }), 'utf8')
}

describe('map-cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-16T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('TTL 分档：通常图 30 天，活动图 map 24h / enemy 12h / evidence 24h', () => {
    expect(ttlFor('1-5', 'map')).toBe(30 * DAY)
    expect(ttlFor('1-5', 'enemy')).toBe(30 * DAY)
    expect(ttlFor('55-3', 'map')).toBe(DAY)
    expect(ttlFor('55-3', 'enemy')).toBe(12 * HOUR)
    expect(ttlFor('55-3', 'evidence')).toBe(DAY)
  })

  it('readFresh 命中 v2 且未过期', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    await writeEntry(roots.v2Root, '2-1', 'map.json', Date.now() - DAY, { ok: 1 })
    const hit = await cache.readFresh<{ ok: number }>('2-1', 'map.json', 'map')
    expect(hit).toMatchObject({ value: { ok: 1 }, source: 'disk' })
  })

  it('v2 未命中时迁移读取 v1 并保留原时间戳', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    const savedAt = Date.now() - 2 * DAY
    await writeEntry(roots.v1Root, '1-5', 'enemy-3.json', savedAt, { legacy: true })
    const hit = await cache.readFresh<{ legacy: boolean }>('1-5', 'enemy-3.json', 'enemy')
    expect(hit).toMatchObject({ value: { legacy: true }, savedAt, source: 'disk' })
    const migrated = await createMapCache({ ...roots, v1Root: join(roots.v1Root, 'gone') })
      .readFresh<{ legacy: boolean }>('1-5', 'enemy-3.json', 'enemy')
    expect(migrated).toMatchObject({ value: { legacy: true }, savedAt })
  })

  it('活动图敌编成 13 小时后过期，readStale 仍可读', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    await writeEntry(roots.v2Root, '55-3', 'enemy-8.json', Date.now() - 13 * HOUR, { e: 1 })
    expect(await cache.readFresh('55-3', 'enemy-8.json', 'enemy')).toBeNull()
    expect(await cache.readStale('55-3', 'enemy-8.json')).toMatchObject({
      value: { e: 1 },
      source: 'disk-stale',
    })
  })

  it('readSnapshot 只对通常图生效，来源标记 snapshot', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    const generatedAt = Date.now() - 40 * DAY
    await writeEntry(roots.snapshotRoot, '3-2', 'map.json', generatedAt, { snap: 1 })
    await writeEntry(roots.snapshotRoot, '55-1', 'map.json', generatedAt, { snap: 2 })
    expect(await cache.readSnapshot('3-2', 'map.json')).toMatchObject({
      value: { snap: 1 },
      savedAt: generatedAt,
      source: 'snapshot',
    })
    expect(await cache.readSnapshot('55-1', 'map.json')).toBeNull()
  })

  it('readSnapshotManifest 读取生成日期', async () => {
    const roots = await makeRoots()
    await mkdir(roots.snapshotRoot, { recursive: true })
    await writeFile(
      join(roots.snapshotRoot, 'manifest.json'),
      JSON.stringify({ generatedAt: 1752624000000, maps: ['1-1'] }),
      'utf8',
    )
    const cache = createMapCache(roots)
    expect(await cache.readSnapshotManifest()).toMatchObject({
      generatedAt: 1752624000000,
      maps: ['1-1'],
    })
    expect(
      await createMapCache({ ...roots, snapshotRoot: null }).readSnapshotManifest(),
    ).toBeNull()
  })

  it('write 后 readFresh 立即可见', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    await cache.write('55-3', 'map.json', { fresh: true })
    expect(await cache.readFresh('55-3', 'map.json', 'map')).toMatchObject({
      value: { fresh: true },
      source: 'disk',
    })
  })
})
