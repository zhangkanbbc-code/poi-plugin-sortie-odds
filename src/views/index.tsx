import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { connect } from 'react-redux'
import {
  Button,
  Callout,
  Card,
  Collapse,
  FormGroup,
  HTMLSelect,
  InputGroup,
  ProgressBar,
  Switch,
  Tag,
} from '@blueprintjs/core'

import {
  ENEMY_NODE_TYPES,
  KCNAV_BASE_URL,
  NODE_TYPE,
  PLUGIN_KEY,
} from '../constants'
import { selectCurrentFleet, selectSupportFleets } from '../selectors'
import {
  buildSimulationInput,
  countSmokeGenerators,
  toPlayerFleet,
} from '../services/adapter'
import { buildLbasInput } from '../services/lbas'
import type { SupportFleets } from '../selectors'
import type { NightPolicy } from '../services/adapter'
import { sourceLabel, summarizeResources } from '../services/data-meta'
import {
  applyProphetSettlement,
  completedEdgeCountFromLogs,
  prophetBattleFingerprint,
  readPluginIntegrations,
} from '../services/integration'
import {
  evidencePayloadCount,
  loadEnemyComps,
  loadGimmicks,
  loadLocalEdgeSamples,
  loadMap,
  loadRouteEvidence,
} from '../services/kcnav'
import { kcnavTransport } from '../services/kcnav-transport'
import { deriveLiveSortie, gaugeBandFor, readEventMapInfo } from '../services/live'
import { mapCache } from '../services/map-cache'
import type { PoiEventMaps, PoiSortieSlice } from '../services/live'
import {
  getRoutingFleetFeatures,
  routingFeatureLabel,
} from '../services/reachability'
import {
  buildRouteChoices,
  getBattleEdges,
  getEdges,
  getTargetOptions,
  isWaitingAtChoice,
  pickAutoTarget,
  rankRoutesByTraffic,
  routeLabel,
} from '../services/route'
import { simulatorBridge } from '../services/simulator'
import { summarizeEngineWarnings } from '../services/warnings'
import type { DataMeta } from '../services/data-meta'
import type { KcnavStatus } from '../services/kcnav-transport'
import type {
  EngineRunResult,
  FleetInspectResult,
  KcnavGimmicksPayload,
  KcnavMapPayload,
  LiveSortieState,
  PoiFleetSnapshot,
  PluginIntegrationState,
  RouteEvidence,
  RouteEdge,
  ShipCapability,
} from '../types'

const CSS = `
.sortie-odds { padding: 12px; height: 100%; overflow: auto; }
.sortie-odds__toolbar { display: grid; grid-template-columns: minmax(120px, 180px) minmax(150px, 220px) 1fr; gap: 10px; align-items: end; }
.sortie-odds__toolbar .bp4-form-group { margin-bottom: 0; }
.sortie-odds__route { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
.sortie-odds__metrics { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 8px; margin: 12px 0; }
.sortie-odds__metric { padding: 12px; text-align: center; }
.sortie-odds__metric-value { font-size: 24px; font-weight: 700; line-height: 1.2; }
.sortie-odds__metric-label { opacity: .72; margin-top: 4px; }
.sortie-odds__nodes { width: 100%; border-collapse: collapse; }
.sortie-odds__nodes th, .sortie-odds__nodes td { padding: 7px 8px; border-bottom: 1px solid rgba(128,128,128,.25); text-align: right; }
.sortie-odds__nodes th:first-child, .sortie-odds__nodes td:first-child { text-align: left; }
.sortie-odds__muted { opacity: .68; }
.sortie-odds__controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
@media (max-width: 900px) {
  .sortie-odds__toolbar { grid-template-columns: 1fr 1fr; }
  .sortie-odds__metrics { grid-template-columns: 1fr 1fr; }
}
`

interface StateProps {
  live: LiveSortieState
  snapshot: PoiFleetSnapshot
  integration: PluginIntegrationState
  eventMaps?: PoiEventMaps
  support: SupportFleets
  airbase?: unknown[]
  equipsById?: Record<string, unknown>
}

const DIFFICULTY_NAMES = new Map<number, string>([
  [1, '丁'],
  [2, '丙'],
  [3, '乙'],
  [4, '甲'],
])

const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'

// 非出击状态的兜底必须是稳定引用，否则依赖它的 useMemo/useEffect 每次渲染都会重跑
const EMPTY_EDGES: number[] = []

// 持久化到 poi config 的设置项（重启不丢）
function usePersistentState<T>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = window.config?.get(`plugin.${PLUGIN_KEY}.${key}`, defaultValue)
    return (stored as T | undefined) ?? defaultValue
  })
  const set = useCallback((next: T) => {
    setValue(next)
    window.config?.set(`plugin.${PLUGIN_KEY}.${key}`, next)
  }, [key])
  return [value, set]
}

const FORMATION_NAMES = new Map<number, string>([
  [1, '单纵'],
  [2, '复纵'],
  [3, '轮形'],
  [4, '梯形'],
  [5, '单横'],
  [11, '第一警戒'],
  [12, '第二警戒'],
  [13, '第三警戒'],
  [14, '第四警戒'],
])

const formationName = (id: number): string => FORMATION_NAMES.get(id) ?? `阵形${id}`

const capabilityText = (
  capabilities: FleetInspectResult,
  snapshot: PoiFleetSnapshot,
): string => {
  const describe = (caps: ShipCapability[], ships: PoiFleetSnapshot['fleets'][number]): string[] =>
    caps.map((cap, index) => {
      const tags = [
        cap.specialAttack ? '特攻' : '',
        cap.dayCutin ? '弹观' : '',
        cap.oasw ? '先制反潜' : '',
        cap.aaciTypes.length ? `对空CI(种别${cap.aaciTypes.join('/')})` : '',
      ].filter(Boolean)
      if (tags.length === 0) return ''
      const name = ships[index]?.[1]?.api_name ?? `${index + 1}号舰`
      return `${name} ${tags.join('·')}`
    }).filter(Boolean)
  return [
    ...describe(capabilities.main, snapshot.fleets[0] ?? []),
    ...describe(capabilities.escort, snapshot.fleets[1] ?? []),
  ].join('；')
}

const fleetShipCount = (snapshot: PoiFleetSnapshot): number =>
  snapshot.fleets.reduce(
    (count, fleet) => count + fleet.filter((ship) => ship != null).length,
    0,
  )

const nodeTypeLabel = (edge: RouteEdge): string => {
  switch (edge.nodeType) {
    case NODE_TYPE.Boss:
      return 'BOSS'
    case NODE_TYPE.AirRaid:
      return '空袭'
    case NODE_TYPE.AirBattle:
      return '航空战'
    case NODE_TYPE.NightBattle:
      return '夜战'
    case NODE_TYPE.SubStrike:
      return '对潜空袭'
    default:
      return '战斗'
  }
}

const SortieOddsView: React.FC<StateProps> = ({
  live,
  snapshot,
  integration,
  eventMaps,
  support,
  airbase,
  equipsById,
}) => {
  const [mapId, setMapId] = useState(live.mapId ?? '1-1')
  const [mapData, setMapData] = useState<KcnavMapPayload | null>(null)
  const [target, setTarget] = useState('')
  const [selectedRoute, setSelectedRoute] = useState('')
  const [samples, setSamples] = usePersistentState('samples', 5000)
  const [autoAnalyze, setAutoAnalyze] = usePersistentState('autoAnalyze', true)
  const [mapLoading, setMapLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<EngineRunResult | null>(null)
  const [sourceCounts, setSourceCounts] = useState<Record<number, number>>({})
  const [routeEvidence, setRouteEvidence] = useState<RouteEvidence>({
    state: 'idle',
    matchedEntries: 0,
  })
  const [kcnav, setKcnav] = useState<KcnavStatus>(kcnavTransport.getStatus())
  const [mapMeta, setMapMeta] = useState<DataMeta | null>(null)
  const [enemyMeta, setEnemyMeta] = useState<DataMeta[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<FleetInspectResult | null>(null)
  const [targetFormation, setTargetFormation] = useState(0)
  const [nightPolicy, setNightPolicy] = usePersistentState<NightPolicy>('nightPolicy', 'always')
  const [useSupport, setUseSupport] = usePersistentState('useSupport', true)
  const [useLbas, setUseLbas] = usePersistentState('useLbas', true)
  const [smokeEdge, setSmokeEdge] = useState(0)
  const [bonusDmgAll, setBonusDmgAll] = usePersistentState('bonusDmgAll', 1)
  const [debuffDmg, setDebuffDmg] = usePersistentState('debuffDmg', 1)
  const [switchToProphet, setSwitchToProphet] = usePersistentState('switchToProphet', true)

  const lbasBaseCount = useMemo(() => {
    const world = Number(mapId.split('-')[0]) || 0
    return buildLbasInput(
      airbase as Parameters<typeof buildLbasInput>[0],
      (equipsById ?? {}) as Parameters<typeof buildLbasInput>[1],
      world,
    ).bases.length
  }, [airbase, equipsById, mapId])
  const [manualDifficulty, setManualDifficulty] = useState(0)

  const isEventMap = Number(mapId.split('-')[0]) >= 10
  const autoEvent = useMemo(
    () => readEventMapInfo(eventMaps, mapId),
    [eventMaps, mapId],
  )
  // 游戏内已选难度是权威；读不到（未开图/计划模式）才用手动选择
  const difficulty = isEventMap ? (autoEvent?.difficulty ?? manualDifficulty) : 0
  // 敌形态筛选：auto=按当前血量取斩杀/通常形态样本；all=不过滤
  const [gaugeMode, setGaugeMode] = usePersistentState<'auto' | 'all'>('gaugeMode', 'auto')
  const gaugeNum = isEventMap ? (autoEvent?.gaugeNum ?? 0) : 0
  const gaugeBand = isEventMap && gaugeMode === 'auto' ? gaugeBandFor(autoEvent) : null
  const runGeneration = useRef(0)
  const evidenceGeneration = useRef(0)
  const [gimmicks, setGimmicks] = useState<KcnavGimmicksPayload | null>(null)
  const [gimmickOpen, setGimmickOpen] = usePersistentState('gimmickOpen', false)

  // 活动图解密条件（KCNav 众包数据，按难度分期），走队列+磁盘缓存
  useEffect(() => {
    setGimmicks(null)
    if (!isEventMap || !/^\d+-\d+$/.test(mapId)) return undefined
    const timer = setTimeout(() => {
      void loadGimmicks(mapId)
        .then((loaded) => setGimmicks(loaded.value))
        .catch(() => setGimmicks(null))
    }, 2000)
    return () => clearTimeout(timer)
  }, [isEventMap, mapId])

  const gimmickPhases = useMemo(() => {
    if (!difficulty) return []
    const phases = gimmicks?.result?.difficulties?.[String(difficulty)]?.phases ?? {}
    return Object.entries(phases)
      .map(([phase, data]) => ({
        phase,
        nodes: Object.entries(data.nodes ?? {})
          .map(([node, rank]) => `${node}:${rank}`)
          .join(' '),
      }))
      .filter((entry) => entry.nodes.length > 0)
      .sort((a, b) => Number(a.phase) - Number(b.phase))
  }, [difficulty, gimmicks])

  useEffect(() => kcnavTransport.subscribe((status) => {
    setKcnav((previous) => (
      previous.state === status.state
      && previous.cooldownUntil === status.cooldownUntil
      && previous.cooldownLevel === status.cooldownLevel
      && previous.queueLength === status.queueLength
        ? previous
        : status
    ))
  }), [])

  useEffect(() => {
    void mapCache.readSnapshotManifest().then((manifest) => {
      if (manifest) {
        setSnapshotDate(new Date(manifest.generatedAt).toISOString().slice(0, 10))
      }
    })
  }, [])

  // 舰队能力判定（与胜率模拟同源）：编成/装备变化后重新询问模拟器
  const fleetKey = useMemo(
    () => JSON.stringify(toPlayerFleet(snapshot)),
    [snapshot],
  )

  useEffect(() => {
    if (fleetShipCount(snapshot) === 0) {
      setCapabilities(null)
      return undefined
    }
    const timer = setTimeout(() => {
      void simulatorBridge
        .inspect({
          fleetF: toPlayerFleet(snapshot),
          formations: snapshot.combinedFlag ? [11, 12, 13, 14] : [1, 2, 3, 4, 5],
        })
        .then(setCapabilities)
        .catch(() => setCapabilities(null))
    }, 1500)
    return () => clearTimeout(timer)
    // snapshot 以 fleetKey 值键参与依赖
  }, [fleetKey])

  useEffect(() => {
    // startedAt 参与依赖：同一海域再次出击也要把手动改过的输入拉回来
    if (live.mapId) setMapId(live.mapId)
  }, [live.mapId, live.startedAt])

  useEffect(() => {
    if (!/^\d+-\d+$/.test(mapId)) {
      setMapData(null)
      return undefined
    }
    let disposed = false
    const timer = setTimeout(() => {
      setMapLoading(true)
      setError(null)
      void loadMap(mapId)
        .then((loaded) => {
          if (disposed) return
          setMapData(loaded.value)
          setMapMeta({ source: loaded.source, savedAt: loaded.savedAt })
        })
        .catch((cause) => {
          if (!disposed) setError(`地图数据加载失败：${String(cause)}`)
        })
        .finally(() => {
          if (!disposed) setMapLoading(false)
        })
    }, 350)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [mapId])

  const targetOptions = useMemo(
    () => (mapData ? getTargetOptions(mapData) : []),
    [mapData],
  )
  const actualEdges = live.active && live.mapId === mapId ? live.actualEdges : EMPTY_EDGES
  const actualEdgesKey = actualEdges.join(',')
  const routeChoices = useMemo(
    () => (mapData && target ? buildRouteChoices(mapData, actualEdges, target) : []),
    [actualEdges, mapData, target],
  )
  const [edgeSamples, setEdgeSamples] = useState<Record<number, number>>({})

  useEffect(() => {
    if (!mapData) {
      setEdgeSamples({})
      return undefined
    }
    let disposed = false
    const battleEdgeIds = getEdges(mapData)
      .filter((edge) => ENEMY_NODE_TYPES.has(edge.nodeType))
      .map((edge) => edge.id)
    void loadLocalEdgeSamples(mapId, battleEdgeIds).then((samples) => {
      if (!disposed) setEdgeSamples(samples)
    })
    return () => {
      disposed = true
    }
  }, [mapData, mapId])

  const routingFeatures = useMemo(
    () => getRoutingFleetFeatures(snapshot),
    [snapshot],
  )
  const routingFeatureKey = JSON.stringify(routingFeatures)
  // 同编成分支统计：查同舰种构成/电探/桶数的舰队实际通过各候选边的次数；
  // 全部命中磁盘缓存时零请求。null = 数据不全，回退全体人流排序。
  // 严格过滤全零时自动放宽（只留舰种构成+难度）重查一档
  const [compCounts, setCompCounts] = useState<Record<number, number> | null>(null)
  const [compRelaxed, setCompRelaxed] = useState(false)
  const compGeneration = useRef(0)

  useEffect(() => {
    const generation = ++compGeneration.current
    setCompCounts(null)
    setCompRelaxed(false)
    if (!mapData || !routingFeatures.mainComp) return undefined
    const traversed = new Set(actualEdges)
    // 目标入口边优先（几条就能定该打哪个 boss），其余候选路线边随后补全；
    // 结果逐边渐进落地，单边失败跳过不作废
    const targetEntryEdges = new Set<number>()
    for (const option of getTargetOptions(mapData)) {
      for (const edge of getEdges(mapData)) {
        if (edge.to === option.to && !traversed.has(edge.id)) targetEntryEdges.add(edge.id)
      }
    }
    const restEdges = new Set<number>()
    for (const option of getTargetOptions(mapData)) {
      for (const route of buildRouteChoices(mapData, actualEdges, option.to, 8)) {
        for (const edge of getBattleEdges(mapData, route)) {
          if (!traversed.has(edge.id) && !targetEntryEdges.has(edge.id)) restEdges.add(edge.id)
        }
      }
    }
    const ordered = [...targetEntryEdges, ...restEdges]
    if (ordered.length === 0) return undefined
    const timer = setTimeout(() => {
      void (async () => {
        const query = async (
          features: typeof routingFeatures,
          markRelaxed: boolean,
        ): Promise<boolean> => {
          const counts: Record<number, number> = {}
          let anyHit = false
          for (const edgeId of ordered) {
            try {
              const loaded = await loadRouteEvidence(mapId, [edgeId], features, {
                difficulty,
                gaugeNum,
              })
              if (generation !== compGeneration.current) return anyHit
              counts[edgeId] = evidencePayloadCount(loaded.value)
              if (counts[edgeId] > 0) anyHit = true
            } catch {
              if (generation !== compGeneration.current) return anyHit
              // 单边失败：跳过，不计入（≠0 样本），整体继续
            }
            if (anyHit) {
              setCompCounts({ ...counts })
              setCompRelaxed(markRelaxed)
            }
          }
          return anyHit
        }
        const strictHit = await query(routingFeatures, false)
        if (generation !== compGeneration.current || strictHit) return
        // 严格条件下一条同编成记录都没有：放宽速力/电探/桶/司令部再查
        await query({
          ...routingFeatures,
          radars: -1,
          drums: -1,
          radarShips: -1,
          speed: 0,
          hqMin: 0,
          hqMax: 0,
        }, true)
      })()
    }, 3000)
    return () => clearTimeout(timer)
  }, [actualEdgesKey, difficulty, gaugeNum, mapData, mapId, routingFeatureKey])

  const rankedRoutes = useMemo(() => {
    if (!mapData) return routeChoices
    const ignore = new Set(actualEdges)
    return rankRoutesByTraffic(mapData, routeChoices, compCounts ?? edgeSamples, ignore)
  }, [actualEdges, compCounts, edgeSamples, mapData, routeChoices])

  // 本次出击内手动选过目标就不再自动改（新出击/换图重置）
  const manualTargetRef = useRef(false)
  useEffect(() => {
    manualTargetRef.current = false
  }, [live.startedAt, mapId])

  useEffect(() => {
    // 自动目标：优先按同编成+期数统计选"本期人流最大"的 boss（多 boss 图区分战力/运输）；
    // 无统计时回退 boss 优先。手动选择在本次出击内粘住
    if (!mapData || manualTargetRef.current) return
    setTarget(pickAutoTarget(mapData, actualEdges, compCounts ?? undefined))
  }, [mapData, actualEdgesKey, live.startedAt, compCounts])

  useEffect(() => {
    const available = new Set(rankedRoutes.map((route) => route.join(',')))
    setSelectedRoute((current) =>
      available.has(current) ? current : (rankedRoutes[0]?.join(',') ?? ''),
    )
  }, [rankedRoutes])

  const effectiveRoute = useMemo(() => {
    const match = rankedRoutes.find((route) => route.join(',') === selectedRoute)
    return match ?? rankedRoutes[0] ?? EMPTY_EDGES
  }, [rankedRoutes, selectedRoute])
  // effect 依赖必须用值键而不是数组引用，见 EMPTY_EDGES 的注释
  const effectiveRouteKey = effectiveRoute.join(',')
  const completedEdgeCount = useMemo(
    () => mapData && live.active && live.mapId === mapId
      ? completedEdgeCountFromLogs(
        mapData,
        actualEdges,
        mapId,
        Number(live.completedEdgeCount ?? 0),
        integration.latestAkashic,
        Number(live.startedAt ?? 0),
      )
      : 0,
    [actualEdges, integration.latestAkashic, live.active, live.completedEdgeCount, live.mapId, live.startedAt, mapData, mapId],
  )
  const remainingRoute = useMemo(
    () => effectiveRoute.slice(Math.min(completedEdgeCount, effectiveRoute.length)),
    [completedEdgeCount, effectiveRoute],
  )
  const battleEdges = useMemo(
    () => (mapData ? getBattleEdges(mapData, remainingRoute) : []),
    [mapData, remainingRoute],
  )
  const waitingForChoice = !!mapData && live.active && isWaitingAtChoice(mapData, actualEdges)
  const smokeCount = useMemo(() => countSmokeGenerators(snapshot), [snapshot])

  // 所选烟幕节点不在剩余路线里时自动清掉
  useEffect(() => {
    if (smokeEdge !== 0 && !battleEdges.some((edge) => edge.id === smokeEdge)) {
      setSmokeEdge(0)
    }
  }, [battleEdges, smokeEdge])
  const targetAlreadySettled = live.active
    && effectiveRoute.length > 0
    && completedEdgeCount >= effectiveRoute.length
  const prophetUpdateKey = useMemo(
    () => prophetBattleFingerprint(integration.prophetBattle),
    [integration.prophetBattle],
  )
  const prophetBattleActive = integration.prophetBattle?.sortieState === 2
    && completedEdgeCount < actualEdges.length

  useEffect(() => {
    setRunResult(null)
    setSourceCounts({})
  }, [completedEdgeCount, difficulty, gaugeMode, mapId, selectedRoute])

  useEffect(() => {
    const generation = ++evidenceGeneration.current
    if (!mapData || !effectiveRoute.length || waitingForChoice || fleetShipCount(snapshot) === 0) {
      setRouteEvidence({ state: 'idle', matchedEntries: 0 })
      return undefined
    }
    setRouteEvidence({ state: 'checking', matchedEntries: 0 })
    const timer = setTimeout(() => {
      void loadRouteEvidence(mapId, effectiveRoute, routingFeatures, { difficulty })
        .then((loaded) => {
          if (generation !== evidenceGeneration.current) return
          const entries = loaded.value.result?.entries ?? []
          setRouteEvidence({
            state: entries.length ? 'supported' : 'unknown',
            matchedEntries: entries.length,
            pageCount: loaded.value.result?.pageCount,
            detail: entries.length
              ? 'KCNav 中存在同舰种构成、同电探/桶数量且走完这条路线的记录。'
              : 'KCNav 暂未返回符合当前编成特征的完整路线记录；这不等于一定会沟。',
          })
        })
        .catch((cause) => {
          if (generation !== evidenceGeneration.current) return
          setRouteEvidence({
            state: 'unavailable',
            matchedEntries: 0,
            detail: cause instanceof Error ? cause.message : String(cause),
          })
        })
    }, 3000)
    return () => clearTimeout(timer)
  }, [difficulty, effectiveRouteKey, mapData, mapId, routingFeatureKey, waitingForChoice])

  const runAnalysis = useCallback(async (trigger: 'manual' | 'auto' = 'manual'): Promise<void> => {
    if (!mapData || !effectiveRoute.length || !battleEdges.length) return
    if (fleetShipCount(snapshot) === 0) {
      setError('当前没有可读取的出击舰队。')
      return
    }
    if (waitingForChoice || prophetBattleActive) return

    const generation = ++runGeneration.current
    setRunning(true)
    setProgress(0)
    setError(null)
    try {
      const priority = trigger === 'manual' ? 'interactive' as const : 'background' as const
      const enemyResults = await Promise.allSettled(
        battleEdges.map((edge) =>
          loadEnemyComps(mapId, edge.id, { priority, difficulty, gaugeNum, gaugeBand })),
      )
      if (generation !== runGeneration.current) return
      const failedNodes = enemyResults
        .map((result, index) => result.status === 'rejected' ? battleEdges[index].to : null)
        .filter((node): node is string => node != null)
      if (failedNodes.length) {
        throw new Error(
          `本地缓存暂缺 ${failedNodes.join('、')} 点敌编成；可点「刷新本图数据」重试，或等待 KCNav 冷却结束`,
        )
      }
      const enemyLoaded = enemyResults.map((result) => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      setEnemyMeta(enemyLoaded.map((item) => ({ source: item.source, savedAt: item.savedAt })))
      const enemyPayloads = enemyLoaded.map((item) => item.value)
      setSourceCounts(
        Object.fromEntries(
          enemyPayloads.map((payload, index) => [
            battleEdges[index].id,
            payload.result.entries.reduce((sum, entry) => sum + Number(entry.count || 0), 0),
          ]),
        ),
      )
      const chosenFormation = targetFormation || (capabilities?.specialFormations[0] ?? 0)
      const world = Number(mapId.split('-')[0]) || 0
      const lbasPlan = buildLbasInput(
        airbase as Parameters<typeof buildLbasInput>[0],
        (equipsById ?? {}) as Parameters<typeof buildLbasInput>[1],
        world,
      )
      const input = buildSimulationInput(
        snapshot,
        battleEdges.map((edge, index) => ({ edge, enemy: enemyPayloads[index] })),
        samples,
        {
          ...(chosenFormation > 0 ? { targetFormation: chosenFormation } : {}),
          nightPolicy,
          ...(useSupport
            ? { supportNormal: support.normal, supportBoss: support.boss }
            : {}),
          ...(useLbas && lbasPlan.bases.length > 0
            ? {
              lbas: lbasPlan.bases,
              targetLbasWaves: lbasPlan.waves,
              lbasStrikes: live.active && live.mapId === mapId ? live.lbasStrikes : null,
            }
            : {}),
          ...(smokeEdge > 0 ? { smokeEdgeId: smokeEdge } : {}),
          ...(bonusDmgAll !== 1 ? { bonusDmgAll } : {}),
          ...(debuffDmg !== 1 ? { debuffDmg } : {}),
        },
      )
      const result = await simulatorBridge.run(input, (value) => {
        if (generation === runGeneration.current) setProgress(value)
      })
      if (generation !== runGeneration.current) return
      setRunResult(result)
      setProgress(1)
    } catch (cause) {
      if (generation === runGeneration.current) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(/Unknown ship.*stats required/i.test(message)
          ? `分析失败：${message} —— 这是活动新敌人，模拟器数据尚未收录；`
            + '待上游（KC3 kancolle-replay）跟进后更新 vendor 数据即可，通常在活动开放后数日内'
          : `分析失败：${message}`)
      }
    } finally {
      if (generation === runGeneration.current) setRunning(false)
    }
  }, [
    airbase,
    autoEvent,
    battleEdges,
    capabilities,
    difficulty,
    gaugeMode,
    effectiveRoute.length,
    equipsById,
    mapData,
    mapId,
    nightPolicy,
    prophetBattleActive,
    bonusDmgAll,
    debuffDmg,
    samples,
    smokeEdge,
    snapshot,
    support,
    targetFormation,
    useLbas,
    useSupport,
    waitingForChoice,
  ])

  const runRef = useRef(runAnalysis)
  useEffect(() => {
    runRef.current = runAnalysis
  }, [runAnalysis])

  const refreshMapData = useCallback(async (): Promise<void> => {
    if (!/^\d+-\d+$/.test(mapId)) return
    setRefreshing(true)
    setError(null)
    try {
      const loaded = await loadMap(mapId, { force: true, priority: 'interactive' })
      setMapData(loaded.value)
      setMapMeta({ source: loaded.source, savedAt: loaded.savedAt })
      for (const edge of getBattleEdges(loaded.value, effectiveRoute)) {
        await loadEnemyComps(mapId, edge.id, {
          force: true,
          priority: 'interactive',
          difficulty,
          gaugeNum,
          gaugeBand,
        })
      }
      await runRef.current('manual')
    } catch (cause) {
      setError(`刷新失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setRefreshing(false)
    }
  }, [difficulty, effectiveRoute, gaugeBand, gaugeNum, mapId])

  useEffect(() => {
    if (
      !autoAnalyze
      || !live.active
      || waitingForChoice
      || prophetBattleActive
      || !effectiveRoute.length
    ) {
      return undefined
    }
    const timer = setTimeout(() => void runRef.current('auto'), 700)
    return () => clearTimeout(timer)
  }, [
    autoAnalyze,
    completedEdgeCount,
    effectiveRouteKey,
    integration.latestAkashic?.timestamp,
    live.active,
    live.updatedAt,
    prophetBattleActive,
    prophetUpdateKey,
    target,
    waitingForChoice,
  ])

  const total = runResult?.result.totalnum ?? 0
  const targetResult = runResult?.result.nodes.at(-1)
  const reached = targetResult?.num ?? 0
  const rankS = targetResult?.ranks.S ?? 0
  const rankA = targetResult?.ranks.A ?? 0
  const reachRate = total ? reached / total : Number.NaN
  const wholeS = total ? rankS / total : Number.NaN
  const wholeAPlus = total ? (rankS + rankA) / total : Number.NaN
  const reachedS = reached ? rankS / reached : Number.NaN
  const reachedAPlus = reached ? (rankS + rankA) / reached : Number.NaN

  return (
    <div className="sortie-odds">
      <style>{CSS}</style>
      <div className="sortie-odds__toolbar">
        <FormGroup label={live.active && live.mapId === mapId ? '海域 · 跟随出击中' : '海域'}>
          <InputGroup
            value={mapId}
            placeholder="例如 5-5"
            onChange={(event) => setMapId(event.currentTarget.value.trim())}
          />
        </FormGroup>
        <FormGroup label="目标点 · 进点自动重选">
          <HTMLSelect
            fill
            value={target}
            onChange={(event) => {
              manualTargetRef.current = true
              setTarget(event.currentTarget.value)
            }}
            options={targetOptions.map((edge) => ({
              value: edge.to,
              label: `${edge.to} · ${nodeTypeLabel(edge)}`,
            }))}
          />
        </FormGroup>
        <FormGroup
          label={`候选路线（${rankedRoutes.length}${
            rankedRoutes.length > 1
              ? compCounts
                ? (compRelaxed ? ' · 同编成排序(放宽)' : ' · 同编成历史排序')
                : ' · 人流排序'
              : ''
          }）`}
        >
          <HTMLSelect
            fill
            value={selectedRoute}
            onChange={(event) => setSelectedRoute(event.currentTarget.value)}
            options={rankedRoutes.map((route) => ({
              value: route.join(','),
              label: mapData ? routeLabel(mapData, route) : route.join(','),
            }))}
          />
        </FormGroup>
      </div>

      <div className="sortie-odds__route">
        <Tag intent={live.active && live.mapId === mapId ? 'success' : 'none'}>
          {prophetBattleActive
            ? '战斗中 · 结算后自动重算'
            : live.active && live.mapId === mapId
              ? '实战状态自动跟随中'
              : '计划分析'}
        </Tag>
        <span>{mapData && effectiveRoute.length ? routeLabel(mapData, effectiveRoute) : '尚无可达路线'}</span>
        <span className="sortie-odds__muted">
          当前读取 {fleetShipCount(snapshot)} 艘舰 · {snapshot.combinedFlag ? '联合舰队' : '通常舰队'}
        </span>
        <Tag intent={integration.prophetAppliedShips > 0 ? 'success' : 'none'}>
          未卜先知：{integration.prophetAppliedShips > 0
            ? `已采用 ${integration.prophetAppliedShips} 艘战后 HP`
            : integration.prophetAvailable ? '已连接' : '未连接'}
        </Tag>
        <Tag intent={integration.latestAkashic?.mapId === mapId ? 'success' : 'none'}>
          航海日志：{integration.latestAkashic?.mapId === mapId
            ? `${integration.latestAkashic.node} 点 ${integration.latestAkashic.rank ?? '已结算'}`
            : integration.akashicAvailable ? '已连接' : '未连接'}
        </Tag>
        <Tag
          intent={kcnav.state === 'cooldown' ? 'danger' : kcnav.state === 'offline' ? 'none' : 'success'}
        >
          {kcnav.state === 'cooldown'
            ? `KCNav 冷却中 · 剩余 ${Math.max(1, Math.ceil((kcnav.cooldownUntil - Date.now()) / 3600000))} 小时`
            : kcnav.state === 'offline'
              ? 'KCNav 离线 · 使用本地数据'
              : 'KCNav 正常'}
        </Tag>
        {kcnav.state === 'cooldown' && (
          <Button
            small
            onClick={() => void kcnavTransport.probe(`${KCNAV_BASE_URL}/maps/1-1`)}
          >
            试探一次
          </Button>
        )}
        {(() => {
          const meta = summarizeResources([...(mapMeta ? [mapMeta] : []), ...enemyMeta])
          return meta
            ? <span className="sortie-odds__muted">敌编成数据：{sourceLabel(meta)}</span>
            : null
        })()}
        {snapshotDate && (
          <span className="sortie-odds__muted">内置数据：{snapshotDate}</span>
        )}
        {isEventMap && autoEvent && (
          <Tag intent="warning">
            难度：{DIFFICULTY_NAMES.get(autoEvent.difficulty) ?? autoEvent.difficulty}
            {autoEvent.gaugeNum > 0 && ` · 第${autoEvent.gaugeNum}条`}
            {autoEvent.maxHp > 0
              && ` · ${autoEvent.gaugeType === 3 ? 'TP' : '血条'} ${
                Math.round((autoEvent.nowHp / autoEvent.maxHp) * 100)
              }%（${autoEvent.nowHp}/${autoEvent.maxHp}）`}
          </Tag>
        )}
        {isEventMap && !autoEvent && (
          <HTMLSelect
            value={manualDifficulty}
            onChange={(event) => setManualDifficulty(Number(event.currentTarget.value))}
            options={[
              { value: 0, label: '难度：未选择（不过滤）' },
              { value: 4, label: '难度：甲' },
              { value: 3, label: '难度：乙' },
              { value: 2, label: '难度：丙' },
              { value: 1, label: '难度：丁' },
            ]}
          />
        )}
        {isEventMap && autoEvent && autoEvent.maxHp > 0 && (
          <HTMLSelect
            value={gaugeMode}
            onChange={(event) => setGaugeMode(event.currentTarget.value as 'auto' | 'all')}
            options={[
              {
                value: 'auto',
                label: gaugeBand
                  ? `敌形态：自动（${gaugeBand[0] === 0 ? '斩杀' : '通常'}样本）`
                  : '敌形态：自动',
              },
              { value: 'all', label: '敌形态：全部样本' },
            ]}
          />
        )}
      </div>

      {capabilities && (
        <div className="sortie-odds__muted" style={{ margin: '0 0 10px' }}>
          机制判定（与模拟同源）：{capabilityText(capabilities, snapshot) || '本队无先制反潜 / 对空CI / 弹观 / 特攻'}
          {capabilities.specialFormations.length > 0
            && ` — 特攻需 ${capabilities.specialFormations.map(formationName).join(' / ')}，阵形「自动」已按此选择`}
        </div>
      )}

      {isEventMap && gimmickPhases.length > 0 && (
        <Callout intent="primary" style={{ marginBottom: 10 }}>
          <div
            style={{ cursor: 'pointer', fontWeight: 600 }}
            onClick={() => setGimmickOpen(!gimmickOpen)}
          >
            {gimmickOpen ? '▾' : '▸'} 本图解密条件（KCNav 众包，按当前难度
            {gimmickOpen ? '' : ` · ${gimmickPhases.length} 期，点击展开`}）
          </div>
          <Collapse isOpen={gimmickOpen}>
            {gimmickPhases.map((entry) => (
              <div key={entry.phase}>第{entry.phase}期：{entry.nodes}</div>
            ))}
            <div className="sortie-odds__muted">
              游戏 API 不暴露解密完成进度（只有当前第几条血条可读）——若开路未完成，实际带路会与预测不符，请以游戏内为准。
            </div>
          </Collapse>
        </Callout>
      )}

      {!waitingForChoice && mapData && effectiveRoute.length > 0 && (
        <Callout
          intent={routeEvidence.state === 'supported'
            ? 'success'
            : routeEvidence.state === 'unknown'
              ? 'warning'
              : 'primary'}
          title={routeEvidence.state === 'supported'
            ? '带路判定：有历史记录，通常可到达目标点'
            : routeEvidence.state === 'checking'
              ? '带路判定：地图路线可达，正在核对当前编成'
              : routeEvidence.state === 'unknown'
                ? '带路判定：地图路线可达，但当前编成无法确认'
                : routeEvidence.state === 'unavailable'
                  ? '带路判定：地图路线可达，历史核验暂不可用'
                  : '带路判定：地图路线可达'}
          style={{ marginBottom: 10 }}
        >
          <div>{routeEvidence.detail ?? '正在从 KCNav 查询同类编成走完所选路线的历史记录。'}</div>
          <div className="sortie-odds__muted">
            核验特征：{routingFeatureLabel(routingFeatures)}。活动锁船等特殊条件仍需在游戏内确认。
          </div>
          {!!snapshot.los?.some((value) => Number.isFinite(value)) && (
            <div className="sortie-odds__muted">
              33式索敌：{snapshot.los
                .map((value, index) =>
                  `系数${index + 1} ${Number.isFinite(value) ? value.toFixed(1) : '—'}`)
                .join(' / ')}（与 wiki 分歧阈值对照用）
            </div>
          )}
        </Callout>
      )}

      {waitingForChoice && (
        <Callout intent="warning" title="等待能动分歧选路">
          选择方向后，poi 收到新的 edge ID，插件会按实际路线自动重算。
        </Callout>
      )}
      {!mapLoading && mapData && routeChoices.length === 0 && target && (
        <Callout intent="warning" title="目标不可达">
          当前实际路线前缀无法到达 {target}，请检查目标点或等待下一次选路。
        </Callout>
      )}
      {targetAlreadySettled && (
        <Callout intent="success" title={`目标点已经结算${live.lastRank ? `：${live.lastRank}` : ''}`}>
          当前路线没有需要继续模拟的战斗点；下次进击或重新出击后会自动建立后续路线。
        </Callout>
      )}
      {error && <Callout intent="danger">{error}</Callout>}

      <div className="sortie-odds__controls">
        <Button
          intent="primary"
          icon="predictive-analysis"
          loading={running || mapLoading}
          disabled={
            !mapData
            || !battleEdges.length
            || waitingForChoice
            || prophetBattleActive
            || targetAlreadySettled
          }
          onClick={() => void runAnalysis('manual')}
        >
          分析当前路线
        </Button>
        <Button
          icon="refresh"
          loading={refreshing}
          disabled={!mapData || kcnav.state === 'cooldown' || running}
          onClick={() => void refreshMapData()}
        >
          刷新本图数据
        </Button>
        <HTMLSelect
          value={samples}
          onChange={(event) => setSamples(Number(event.currentTarget.value))}
          options={[
            { value: 1000, label: '1,000 次（快）' },
            { value: 5000, label: '5,000 次' },
            { value: 10000, label: '10,000 次（稳）' },
          ]}
        />
        <HTMLSelect
          value={targetFormation}
          onChange={(event) => setTargetFormation(Number(event.currentTarget.value))}
          options={[
            {
              value: 0,
              label: capabilities?.specialFormations.length
                ? `目标点阵形：自动（特攻→${formationName(capabilities.specialFormations[0])}）`
                : '目标点阵形：自动',
            },
            ...(snapshot.combinedFlag ? [11, 12, 13, 14] : [1, 2, 3, 4, 5]).map((id) => ({
              value: id,
              label: `目标点阵形：${formationName(id)}`,
            })),
          ]}
        />
        <HTMLSelect
          value={nightPolicy}
          onChange={(event) => setNightPolicy(event.currentTarget.value as NightPolicy)}
          options={[
            { value: 'always', label: '目标点夜战：总是进（求S）' },
            { value: 'ifBelowA', label: '目标点夜战：未达A才进' },
            { value: 'never', label: '目标点夜战：不进' },
          ]}
        />
        <Switch
          checked={useSupport && (!!support.normal || !!support.boss)}
          disabled={!support.normal && !support.boss}
          label={support.normal || support.boss
            ? `支援：${[support.normal && '道中', support.boss && '决战']
              .filter(Boolean)
              .join('+')}`
            : '支援：未出港'}
          onChange={(event) => setUseSupport(event.currentTarget.checked)}
        />
        {isEventMap && (
          <HTMLSelect
            value={bonusDmgAll}
            onChange={(event) => setBonusDmgAll(Number(event.currentTarget.value))}
            options={[1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5, 1.6, 1.75, 2].map(
              (value) => ({
                value,
                label: value === 1 ? '特效倍率：无' : `特效倍率：×${value}`,
              }),
            )}
          />
        )}
        {isEventMap && (
          <HTMLSelect
            value={debuffDmg}
            onChange={(event) => setDebuffDmg(Number(event.currentTarget.value))}
            options={[1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2].map((value) => ({
              value,
              label: value === 1 ? '破甲：未完成' : `破甲：×${value}`,
            }))}
          />
        )}
        {smokeCount > 0 && (
          <HTMLSelect
            value={smokeEdge}
            onChange={(event) => setSmokeEdge(Number(event.currentTarget.value))}
            options={[
              { value: 0, label: `烟幕（${smokeCount}本）：不使用` },
              ...battleEdges.map((edge) => ({
                value: edge.id,
                label: `烟幕：${edge.to} 点展开`,
              })),
            ]}
          />
        )}
        <Switch
          checked={useLbas && lbasBaseCount > 0}
          disabled={lbasBaseCount === 0}
          label={lbasBaseCount > 0
            ? (live.active && live.mapId === mapId && live.lbasStrikes
              ? `基航：${live.lbasStrikes.length} 队·实际派遣`
              : `基航：${lbasBaseCount} 队→目标点`)
            : '基航：无出击队'}
          onChange={(event) => setUseLbas(event.currentTarget.checked)}
        />
        <Switch
          checked={autoAnalyze}
          label="自动跟随出击并重算"
          onChange={(event) => setAutoAnalyze(event.currentTarget.checked)}
        />
        <Switch
          checked={switchToProphet}
          label="战斗时切到未卜先知"
          onChange={(event) => setSwitchToProphet(event.currentTarget.checked)}
        />
      </div>
      {running && <ProgressBar value={progress} animate stripes />}

      {runResult && targetResult && (
        <>
          <div className="sortie-odds__metrics">
            <Card className="sortie-odds__metric">
              <div className="sortie-odds__metric-value">{formatPercent(wholeS)}</div>
              <div className="sortie-odds__metric-label">从当前状态到目标 S 胜</div>
            </Card>
            <Card className="sortie-odds__metric">
              <div className="sortie-odds__metric-value">{formatPercent(wholeAPlus)}</div>
              <div className="sortie-odds__metric-label">从当前状态到目标 A 胜以上</div>
            </Card>
            <Card className="sortie-odds__metric">
              <div className="sortie-odds__metric-value">{formatPercent(reachRate)}</div>
              <div className="sortie-odds__metric-label">目标点到达率</div>
            </Card>
            <Card className="sortie-odds__metric">
              <div className="sortie-odds__metric-value">
                {formatPercent(reachedS)} / {formatPercent(reachedAPlus)}
              </div>
              <div className="sortie-odds__metric-label">抵达后 S / A+</div>
            </Card>
          </div>

          {isEventMap && autoEvent && total > 0
            && (runResult.result.totalTransport ?? 0) > 0 && (() => {
            const avgTp = (runResult.result.totalTransport ?? 0) / total
            const tpS = capabilities?.transportS ?? 0
            const tpA = Math.floor(tpS * 0.7)
            const rankBelow = total > 0
              ? Math.max(0, total - reached + (reached - rankS - rankA))
              : 0
            const runsLeft = avgTp > 0 && autoEvent.nowHp > 0
              ? Math.ceil(autoEvent.nowHp / avgTp)
              : 0
            return (
              <div className="sortie-odds__muted" style={{ margin: '0 0 10px' }}>
                输送结算：
                {tpS > 0 && `本队 TP 容量 S=${tpS} / A=${tpA} ｜ `}
                期望 {avgTp.toFixed(1)} TP/次
                （S {formatPercent(total ? rankS / total : Number.NaN)}
                ×{tpS > 0 ? tpS : '全额'} + A {formatPercent(total ? rankA / total : Number.NaN)}
                ×{tpS > 0 ? tpA : '7成'} + B以下 {formatPercent(total ? rankBelow / total : Number.NaN)}×0）
                {runsLeft > 0
                  && ` ｜ 按剩余条值 ${autoEvent.nowHp} 折算预计还需 ${runsLeft} 次`}
              </div>
            )
          })()}

          <Card>
            <table className="sortie-odds__nodes">
              <thead>
                <tr>
                  <th>节点</th>
                  <th>敌编成样本</th>
                  <th>到达率</th>
                  <th>本点大破率</th>
                  <th>S</th>
                  <th>A+</th>
                </tr>
              </thead>
              <tbody>
                {runResult.result.nodes.map((node, index) => {
                  const edge = battleEdges[index]
                  const nodeReached = total ? node.num / total : Number.NaN
                  const nodeTaiha = node.num ? node.taiha / node.num : Number.NaN
                  const nodeS = node.num ? node.ranks.S / node.num : Number.NaN
                  const nodeA = node.num ? (node.ranks.S + node.ranks.A) / node.num : Number.NaN
                  return (
                    <tr key={`${edge?.id ?? index}`}>
                      <td>{edge?.to ?? index + 1} · {edge ? nodeTypeLabel(edge) : ''}</td>
                      <td>{sourceCounts[edge?.id] ?? '—'}</td>
                      <td>{formatPercent(nodeReached)}</td>
                      <td>{formatPercent(nodeTaiha)}</td>
                      <td>{formatPercent(nodeS)}</td>
                      <td>{formatPercent(nodeA)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>

          {!!runResult.warnings?.length && (
            <Callout intent="warning" title="模拟器提示" style={{ marginTop: 10 }}>
              {summarizeEngineWarnings(runResult.warnings).map((line, index) => (
                <div key={`warning-${index}`}>{line}</div>
              ))}
            </Callout>
          )}
        </>
      )}

      <Callout style={{ marginTop: 12 }}>
        v0.4 起 KCNav 请求全程串行节流；收到自动化拒绝会自动熔断并只用本地数据，可用「试探一次」恢复。
        通常图与活动图的数据都会保存本地缓存（活动图敌编成 12 小时、地图 24 小时后自动刷新）。
        打完的节点会从后续模拟中移除，并优先采用未卜先知推演出的战后 HP。
        支援舰队、基地航空队、友军、活动特效与漩涡消耗尚未接入，当前结果仍是基线估计。
      </Callout>
    </div>
  )
}

const mapStateToProps = (state: PoiRootState): StateProps => {
  const live = deriveLiveSortie(
    state.ext?.[PLUGIN_KEY] as LiveSortieState | undefined,
    state.sortie as PoiSortieSlice | undefined,
  )
  const integration = readPluginIntegrations(state)
  const applied = applyProphetSettlement(
    selectCurrentFleet(state),
    integration.prophetBattle,
    live.lastRank,
  )
  return {
    live,
    snapshot: applied.snapshot,
    integration: { ...integration, prophetAppliedShips: applied.appliedShips },
    eventMaps: state.info?.maps as PoiEventMaps | undefined,
    support: selectSupportFleets(state),
    airbase: state.info?.airbase,
    equipsById: state.info?.equips,
  }
}

export const SortieOdds = connect(mapStateToProps)(SortieOddsView)
