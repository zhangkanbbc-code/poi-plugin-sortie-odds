import { KCNAV_BASE_URL } from '../constants'
import {
  KcnavAutomationError,
  KcnavCooldownError,
  kcnavTransport,
} from './kcnav-transport'
import { isNormalMap, mapCache } from './map-cache'
import type { KcnavTransport, TransportPriority } from './kcnav-transport'
import type { CachedResource, MapCache, ResourceKind } from './map-cache'
import type {
  KcnavEnemyPayload,
  KcnavGimmicksPayload,
  KcnavMapPayload,
  KcnavRouteEntryPayload,
  RoutingFleetFeatures,
} from '../types'

export interface LoadOptions {
  force?: boolean
  priority?: TransportPriority
  // 活动图难度（1丁/2丙/3乙/4甲），0 或省略 = 不过滤；通常图忽略
  difficulty?: number
  // 活动图当前第几条血条（期数），精确过滤敌编成样本
  gaugeNum?: number
  // 活动图血量带 [min, max]（原始 HP 值），区分斩杀/通常形态样本
  gaugeBand?: [number, number] | null
}

export interface KcnavClient {
  loadMap: (
    mapId: string,
    options?: LoadOptions,
  ) => Promise<CachedResource<KcnavMapPayload>>
  loadEnemyComps: (
    mapId: string,
    edgeId: number,
    options?: LoadOptions,
  ) => Promise<CachedResource<KcnavEnemyPayload>>
  loadRouteEvidence: (
    mapId: string,
    edgeIds: number[],
    features: RoutingFleetFeatures,
    options?: LoadOptions,
  ) => Promise<CachedResource<KcnavRouteEntryPayload>>
  loadLocalEdgeSamples: (
    mapId: string,
    edgeIds: number[],
  ) => Promise<Record<number, number>>
  loadGimmicks: (
    mapId: string,
    options?: LoadOptions,
  ) => Promise<CachedResource<KcnavGimmicksPayload>>
}

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

// perPage=1 的核验查询里 pageCount 即同编成通过该边的总次数
export const evidencePayloadCount = (payload: KcnavRouteEntryPayload): number => {
  const pages = Number(payload.result?.pageCount)
  if (Number.isFinite(pages) && pages >= 0) return pages
  return payload.result?.entries?.length ?? 0
}

export const evidenceKey = (
  mapId: string,
  edgeIds: number[],
  features: RoutingFleetFeatures,
): string => {
  const raw = JSON.stringify([
    mapId,
    edgeIds,
    features.fleetType,
    features.fleetNum,
    features.mainComp,
    features.escortComp,
    features.radars,
    features.drums,
    features.radarShips,
    features.speed,
    features.hqMin,
    features.hqMax,
  ])
  let hash = 5381
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash * 33) ^ raw.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const createKcnavClient = (
  transport: KcnavTransport,
  cache: MapCache,
): KcnavClient => {
  const inFlight = new Map<string, Promise<CachedResource<unknown>>>()

  const dedupe = <T>(
    key: string,
    run: () => Promise<CachedResource<T>>,
  ): Promise<CachedResource<T>> => {
    const pending = inFlight.get(key) as Promise<CachedResource<T>> | undefined
    if (pending) return pending
    const promise = run().finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key)
    })
    inFlight.set(key, promise as Promise<CachedResource<unknown>>)
    return promise
  }

  const resolveResource = async <T>(
    mapId: string,
    name: string,
    kind: ResourceKind,
    fetchRemote: () => Promise<T>,
    shouldPersist: (value: T) => boolean,
    options?: LoadOptions,
  ): Promise<CachedResource<T>> => {
    if (!options?.force) {
      const fresh = await cache.readFresh<T>(mapId, name, kind)
      if (fresh) return fresh
      if (isNormalMap(mapId)) {
        const snapshot = await cache.readSnapshot<T>(mapId, name)
        if (snapshot) return snapshot
        const stale = await cache.readStale<T>(mapId, name)
        if (stale) return stale
      }
    }
    try {
      const value = await fetchRemote()
      if (shouldPersist(value)) await cache.write(mapId, name, value)
      return { value, savedAt: Date.now(), source: 'network' }
    } catch (error) {
      if (!options?.force) {
        const stale = await cache.readStale<T>(mapId, name)
        if (stale) return stale
        const snapshot = await cache.readSnapshot<T>(mapId, name)
        if (snapshot) return snapshot
      }
      throw error
    }
  }

  return {
    loadMap: (mapId, options) =>
      dedupe(`map:${mapId}:${options?.force ? 'f' : ''}`, () =>
        resolveResource<KcnavMapPayload>(
          mapId,
          'map.json',
          'map',
          () =>
            transport.request(
              `${KCNAV_BASE_URL}/maps/${encodeURIComponent(mapId)}`,
              options,
            ),
          () => true,
          options,
        )),
    loadEnemyComps: (mapId, edgeId, options) => {
      const isEvent = !isNormalMap(mapId)
      const difficulty = isEvent && options?.difficulty ? options.difficulty : 0
      const gaugeNum = isEvent && options?.gaugeNum ? options.gaugeNum : 0
      const gaugeBand = isEvent ? (options?.gaugeBand ?? null) : null
      const suffix = [
        difficulty > 0 ? `-d${difficulty}` : '',
        gaugeNum > 0 ? `-g${gaugeNum}` : '',
        gaugeBand ? `-l${gaugeBand[0]}-${gaugeBand[1]}` : '',
      ].join('')
      const name = `enemy-${edgeId}${suffix}.json`
      return dedupe(`enemy:${mapId}:${edgeId}:${suffix}:${options?.force ? 'f' : ''}`, () =>
        resolveResource<KcnavEnemyPayload>(
          mapId,
          name,
          'enemy',
          async () => {
            const windows = isNormalMap(mapId) ? [180, 45] : [90, 21]
            let lastError: unknown
            for (const days of windows) {
              const params = new URLSearchParams({
                start: isoDaysAgo(days),
                compsLimit: '100',
              })
              if (difficulty > 0) params.set('difficulty', String(difficulty))
              if (gaugeNum > 0) {
                params.set('minGauge', String(gaugeNum))
                params.set('maxGauge', String(gaugeNum))
              }
              if (gaugeBand) {
                params.set('minGaugeLevel', String(gaugeBand[0]))
                params.set('maxGaugeLevel', String(gaugeBand[1]))
              }
              try {
                const payload = await transport.request<KcnavEnemyPayload>(
                  `${KCNAV_BASE_URL}/maps/${encodeURIComponent(mapId)}/edges/${edgeId}/enemycomps?${params.toString()}`,
                  options,
                )
                if (payload.result?.entries?.length) return payload
                lastError = new Error(`${mapId} 边 ${edgeId} 没有可用敌编成数据`)
              } catch (error) {
                lastError = error
                if (
                  error instanceof KcnavCooldownError
                  || error instanceof KcnavAutomationError
                ) break
              }
            }
            throw lastError instanceof Error
              ? lastError
              : new Error('KCNav 敌编成暂时不可用')
          },
          (payload) => !!payload.result?.entries?.length,
          options,
        ))
    },
    loadLocalEdgeSamples: async (mapId, edgeIds) => {
      const sumCounts = (payload: KcnavEnemyPayload | null | undefined): number =>
        (payload?.result?.entries ?? []).reduce(
          (sum, entry) => sum + Math.max(0, Number(entry.count || 0)),
          0,
        )
      const samples: Record<number, number> = {}
      for (const edgeId of edgeIds) {
        const name = `enemy-${edgeId}.json`
        const hit = (await cache.readFresh<KcnavEnemyPayload>(mapId, name, 'enemy'))
          ?? (await cache.readSnapshot<KcnavEnemyPayload>(mapId, name))
          ?? (await cache.readStale<KcnavEnemyPayload>(mapId, name))
        samples[edgeId] = sumCounts(hit?.value)
      }
      return samples
    },
    loadGimmicks: (mapId, options) => {
      // 解密只存在于活动图；通常图直接返回空结果，不发请求
      if (isNormalMap(mapId)) {
        return Promise.resolve({
          value: {} as KcnavGimmicksPayload,
          savedAt: Date.now(),
          source: 'disk' as const,
        })
      }
      return dedupe(`gimmicks:${mapId}`, () =>
        resolveResource<KcnavGimmicksPayload>(
          mapId,
          'gimmicks.json',
          'map',
          () =>
            transport.request(
              `${KCNAV_BASE_URL}/maps/${encodeURIComponent(mapId)}/gimmicks`,
              options,
            ),
          (payload) => !!payload.result?.difficulties,
          options,
        ))
    },
    loadRouteEvidence: (mapId, edgeIds, features, options) => {
      const difficulty = !isNormalMap(mapId) && options?.difficulty ? options.difficulty : 0
      const gaugeNum = !isNormalMap(mapId) && options?.gaugeNum ? options.gaugeNum : 0
      const name = `evidence-${evidenceKey(mapId, edgeIds, features)}${
        difficulty > 0 ? `-d${difficulty}` : ''
      }${gaugeNum > 0 ? `-g${gaugeNum}` : ''}.json`
      return dedupe(`evidence:${mapId}:${name}`, () =>
        resolveResource<KcnavRouteEntryPayload>(
          mapId,
          name,
          'evidence',
          () => {
            // 负值哨兵 = 放宽该维度（样本稀少时的第二档查询）
            const params = new URLSearchParams({
              page: '0',
              perPage: '1',
              fleetType: String(features.fleetType),
              fleetNum: String(features.fleetNum),
              mainComp: features.mainComp,
              useMainFs: 'false',
            })
            if (features.radars >= 0) {
              params.set('minRadars', String(features.radars))
              params.set('maxRadars', String(features.radars))
            }
            if (features.drums >= 0) {
              params.set('minDrums', String(features.drums))
              params.set('maxDrums', String(features.drums))
            }
            if (features.escortComp) {
              params.set('escortComp', features.escortComp)
              params.set('useEscortFs', 'false')
            }
            if (features.radarShips >= 0) {
              params.set('minRadarShips', String(features.radarShips))
              params.set('maxRadarShips', String(features.radarShips))
            }
            if (features.speed > 0) {
              params.set('minSpeed', String(features.speed))
              params.set('maxSpeed', String(features.speed))
            }
            if (features.hqMin > 0 && features.hqMax > 0) {
              params.set('minHqLevel', String(features.hqMin))
              params.set('maxHqLevel', String(features.hqMax))
            }
            if (difficulty > 0) params.set('difficulty', String(difficulty))
            if (gaugeNum > 0) {
              params.set('minGauge', String(gaugeNum))
              params.set('maxGauge', String(gaugeNum))
            }
            if (isNormalMap(mapId)) params.set('start', isoDaysAgo(180))
            return transport.request(
              `${KCNAV_BASE_URL}/maps/${encodeURIComponent(mapId)}/edges/${edgeIds.join(',')}/entries?${params.toString()}`,
              options,
            )
          },
          () => true,
          options,
        ))
    },
  }
}

const defaultClient = createKcnavClient(kcnavTransport, mapCache)

export const loadMap = defaultClient.loadMap
export const loadEnemyComps = defaultClient.loadEnemyComps
export const loadRouteEvidence = defaultClient.loadRouteEvidence
export const loadLocalEdgeSamples = defaultClient.loadLocalEdgeSamples
export const loadGimmicks = defaultClient.loadGimmicks
