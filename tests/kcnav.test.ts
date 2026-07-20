import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  createKcnavClient,
  evidenceKey,
  evidencePayloadCount,
} from '../src/services/kcnav'
import { createMapCache } from '../src/services/map-cache'
import type { KcnavTransport } from '../src/services/kcnav-transport'
import type { RoutingFleetFeatures } from '../src/types'

const makeRoots = async () => {
  const base = await mkdtemp(join(tmpdir(), 'sortie-odds-client-'))
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

const fakeTransport = (
  impl: (url: string) => Promise<unknown>,
): { transport: KcnavTransport; requestMock: ReturnType<typeof vi.fn> } => {
  const requestMock = vi.fn(impl)
  return {
    transport: {
      request: requestMock as unknown as KcnavTransport['request'],
      probe: async () => true,
      getStatus: () => ({ state: 'ok', cooldownUntil: 0, cooldownLevel: 0, queueLength: 0 }),
      subscribe: () => () => undefined,
    },
    requestMock,
  }
}

const features: RoutingFleetFeatures = {
  fleetType: 0,
  fleetNum: 1,
  mainComp: 'DD DD CL',
  escortComp: '',
  radars: 2,
  drums: 0,
  radarShips: 2,
  speed: 10,
  hqMin: 105,
  hqMax: 115,
}

const mapPayload = { result: { route: { '0': [null, '1', 0, 0] } } }
const enemyPayload = {
  result: { entryCount: 1, entries: [{ formation: 1, count: 3, fleet: [] }] },
}
const emptyEnemyPayload = { result: { entryCount: 0, entries: [] } }

describe('kcnav client', () => {
  it('通常图：磁盘新数据优先，不发网络请求', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.v2Root, '2-1', 'map.json', Date.now(), mapPayload)
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadMap('2-1')
    expect(result.source).toBe('disk')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('通常图：无磁盘时用快照，不发网络请求', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.snapshotRoot, '2-1', 'map.json', Date.now() - 90 * 86400000, mapPayload)
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadMap('2-1')
    expect(result.source).toBe('snapshot')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('通常图：什么都没有才走网络并写盘', async () => {
    const roots = await makeRoots()
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const cache = createMapCache(roots)
    const client = createKcnavClient(transport, cache)
    const first = await client.loadMap('2-1')
    expect(first.source).toBe('network')
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(await cache.readFresh('2-1', 'map.json', 'map')).not.toBeNull()
  })

  it('force 时即使磁盘有新数据也走网络', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.v2Root, '2-1', 'map.json', Date.now(), mapPayload)
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadMap('2-1', { force: true })
    expect(result.source).toBe('network')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('活动图：网络失败回退陈旧缓存', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.v2Root, '55-1', 'enemy-3.json', Date.now() - 20 * 86400000, enemyPayload)
    const { transport } = fakeTransport(async () => {
      throw new Error('network down')
    })
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadEnemyComps('55-1', 3)
    expect(result.source).toBe('disk-stale')
    expect(result.value.result.entries.length).toBe(1)
  })

  it('敌编成第一窗口为空时尝试第二窗口', async () => {
    const roots = await makeRoots()
    const responses: unknown[] = [emptyEnemyPayload, enemyPayload]
    const { transport, requestMock } = fakeTransport(async () => responses.shift())
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadEnemyComps('2-1', 5)
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(result.value.result.entries.length).toBe(1)
  })

  it('带路核验按图+路线+特征缓存，第二次不再请求', async () => {
    const roots = await makeRoots()
    const payload = { result: { entries: [{}], pageCount: 1 } }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadRouteEvidence('2-1', [1, 2, 8], features)
    await client.loadRouteEvidence('2-1', [1, 2, 8], features)
    expect(requestMock).toHaveBeenCalledTimes(1)
    await client.loadRouteEvidence('2-1', [1, 2, 8], { ...features, radars: 3 })
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('loadLocalEdgeSamples 只读本地数据、绝不发网络请求', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.snapshotRoot, '1-5', 'enemy-5.json', Date.now(), {
      result: { entryCount: 2, entries: [{ count: 100 }, { count: 50 }] },
    })
    await writeEntry(roots.v2Root, '1-5', 'enemy-3.json', Date.now(), {
      result: { entryCount: 1, entries: [{ count: 733 }] },
    })
    const { transport, requestMock } = fakeTransport(async () => enemyPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const samples = await client.loadLocalEdgeSamples('1-5', [5, 3, 99])
    expect(samples).toEqual({ 5: 150, 3: 733, 99: 0 })
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('活动图敌编成按难度过滤且缓存分难度', async () => {
    const roots = await makeRoots()
    const { transport, requestMock } = fakeTransport(async () => enemyPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadEnemyComps('55-1', 8, { difficulty: 4 })
    expect(String(requestMock.mock.calls[0][0])).toContain('difficulty=4')
    // 同难度第二次命中缓存
    await client.loadEnemyComps('55-1', 8, { difficulty: 4 })
    expect(requestMock).toHaveBeenCalledTimes(1)
    // 换难度必须重新请求
    await client.loadEnemyComps('55-1', 8, { difficulty: 2 })
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(String(requestMock.mock.calls[1][0])).toContain('difficulty=2')
  })

  it('活动图敌编成按期数与血量带过滤且缓存分带', async () => {
    const roots = await makeRoots()
    const { transport, requestMock } = fakeTransport(async () => enemyPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadEnemyComps('62-3', 8, {
      difficulty: 4,
      gaugeNum: 2,
      gaugeBand: [0, 600],
    })
    const url = String(requestMock.mock.calls[0][0])
    expect(url).toContain('minGauge=2')
    expect(url).toContain('maxGauge=2')
    expect(url).toContain('minGaugeLevel=0')
    expect(url).toContain('maxGaugeLevel=600')
    // 换血量带必须重新请求（缓存名不同）
    await client.loadEnemyComps('62-3', 8, {
      difficulty: 4,
      gaugeNum: 2,
      gaugeBand: [600, 2000],
    })
    expect(requestMock).toHaveBeenCalledTimes(2)
    // 同带命中缓存
    await client.loadEnemyComps('62-3', 8, {
      difficulty: 4,
      gaugeNum: 2,
      gaugeBand: [600, 2000],
    })
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('通常图不携带难度参数', async () => {
    const roots = await makeRoots()
    const { transport, requestMock } = fakeTransport(async () => enemyPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadEnemyComps('2-1', 5, { difficulty: 4 })
    expect(String(requestMock.mock.calls[0][0])).not.toContain('difficulty')
  })

  it('带路核验的期数参与查询与缓存键', async () => {
    const roots = await makeRoots()
    const payload = { result: { entries: [{}], pageCount: 1 } }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadRouteEvidence('55-1', [1, 2], features, { difficulty: 4, gaugeNum: 2 })
    const url = String(requestMock.mock.calls[0][0])
    expect(url).toContain('minGauge=2')
    expect(url).toContain('maxGauge=2')
    await client.loadRouteEvidence('55-1', [1, 2], features, { difficulty: 4, gaugeNum: 3 })
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('带路核验的难度参与查询与缓存键', async () => {
    const roots = await makeRoots()
    const payload = { result: { entries: [{}], pageCount: 1 } }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadRouteEvidence('55-1', [1, 2], features, { difficulty: 4 })
    expect(String(requestMock.mock.calls[0][0])).toContain('difficulty=4')
    await client.loadRouteEvidence('55-1', [1, 2], features, { difficulty: 2 })
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('放宽模式（-1/0 哨兵值）不携带对应过滤参数', async () => {
    const roots = await makeRoots()
    const payload = { result: { entries: [{}], pageCount: 1 } }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadRouteEvidence('55-1', [1, 2], {
      ...features,
      radars: -1,
      drums: -1,
      radarShips: -1,
      speed: 0,
      hqMin: 0,
      hqMax: 0,
    })
    const url = String(requestMock.mock.calls[0][0])
    expect(url).not.toContain('minRadars')
    expect(url).not.toContain('minDrums')
    expect(url).not.toContain('minRadarShips')
    expect(url).not.toContain('minSpeed')
    expect(url).not.toContain('minHqLevel')
    expect(url).toContain('mainComp=')
  })

  it('带路核验查询携带速力/电探舰数/司令部过滤参数', async () => {
    const roots = await makeRoots()
    const payload = { result: { entries: [{}], pageCount: 1 } }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadRouteEvidence('2-1', [1, 2, 8], features)
    const url = String(requestMock.mock.calls[0][0])
    expect(url).toContain('minSpeed=10')
    expect(url).toContain('maxSpeed=10')
    expect(url).toContain('minRadarShips=2')
    expect(url).toContain('maxRadarShips=2')
    expect(url).toContain('minHqLevel=105')
    expect(url).toContain('maxHqLevel=115')
  })

  it('速力/司令部未知（0）时不携带对应参数', async () => {
    const roots = await makeRoots()
    const payload = { result: { entries: [{}], pageCount: 1 } }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadRouteEvidence('2-1', [1, 2, 8], {
      ...features,
      speed: 0,
      hqMin: 0,
      hqMax: 0,
    })
    const url = String(requestMock.mock.calls[0][0])
    expect(url).not.toContain('minSpeed')
    expect(url).not.toContain('minHqLevel')
    expect(url).toContain('minRadarShips=2')
  })

  it('loadGimmicks 只对活动图请求并缓存', async () => {
    const roots = await makeRoots()
    const payload = {
      result: {
        map: '62-3',
        difficulties: { '4': { phases: { '2': { nodes: { B2: 'S' } } } } },
      },
    }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const first = await client.loadGimmicks('62-3')
    expect(String(requestMock.mock.calls[0][0])).toContain('/maps/62-3/gimmicks')
    expect(first.value.result?.difficulties?.['4']).toBeDefined()
    await client.loadGimmicks('62-3')
    expect(requestMock).toHaveBeenCalledTimes(1)
    // 通常图不请求
    const normal = await client.loadGimmicks('2-1')
    expect(normal.value.result).toBeUndefined()
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('evidencePayloadCount：perPage=1 时 pageCount 即同编成通过总数', () => {
    expect(evidencePayloadCount({ result: { entries: [{}], pageCount: 57 } })).toBe(57)
    expect(evidencePayloadCount({ result: { entries: [{}] } })).toBe(1)
    expect(evidencePayloadCount({ result: { entries: [], pageCount: 0 } })).toBe(0)
    expect(evidencePayloadCount({})).toBe(0)
  })

  it('evidenceKey 稳定且对特征敏感', () => {
    const base = evidenceKey('2-1', [1, 2, 8], features)
    expect(evidenceKey('2-1', [1, 2, 8], { ...features })).toBe(base)
    expect(evidenceKey('2-1', [1, 2, 9], features)).not.toBe(base)
    expect(evidenceKey('2-1', [1, 2, 8], { ...features, drums: 4 })).not.toBe(base)
  })
})
