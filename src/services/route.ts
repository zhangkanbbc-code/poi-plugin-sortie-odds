import { ENEMY_NODE_TYPES, NODE_TYPE } from '../constants'
import type { KcnavMapPayload, RouteEdge } from '../types'

export const getEdges = (map: KcnavMapPayload): RouteEdge[] =>
  Object.entries(map.result.route)
    .filter(([id, value]) => id !== '0' && value[0] != null)
    .map(([id, [from, to, nodeType, eventKind]]) => ({
      id: Number(id),
      from,
      to,
      nodeType,
      eventKind,
    }))
    .filter((edge) => Number.isFinite(edge.id))

// 活动图与部分通常图有多个起点：route 中所有 from=null 的边都是起点标记
export const getStartNodes = (map: KcnavMapPayload): string[] => {
  const starts = Object.values(map.result.route)
    .filter((value) => value[0] == null && value[1])
    .map((value) => value[1])
  if (starts.length > 0) return [...new Set(starts)]
  const edges = getEdges(map)
  const destinations = new Set(edges.map((edge) => edge.to))
  return [edges.find((edge) => edge.from && !destinations.has(edge.from))?.from ?? 'Start']
}

export const getEdgeMap = (map: KcnavMapPayload): Map<number, RouteEdge> =>
  new Map(getEdges(map).map((edge) => [edge.id, edge]))

export const enumeratePaths = (
  map: KcnavMapPayload,
  start: string,
  target: string,
  limit = 64,
): number[][] => {
  if (!target) return []
  if (start === target) return [[]]

  const adjacency = new Map<string, RouteEdge[]>()
  for (const edge of getEdges(map)) {
    if (!edge.from) continue
    const list = adjacency.get(edge.from) ?? []
    list.push(edge)
    adjacency.set(edge.from, list)
  }
  for (const list of adjacency.values()) list.sort((a, b) => a.id - b.id)

  const paths: number[][] = []
  const visit = (node: string, seen: Set<string>, path: number[]): void => {
    if (paths.length >= limit || path.length > 40) return
    for (const edge of adjacency.get(node) ?? []) {
      if (seen.has(edge.to)) continue
      const nextPath = [...path, edge.id]
      if (edge.to === target) {
        paths.push(nextPath)
        if (paths.length >= limit) return
        continue
      }
      const nextSeen = new Set(seen)
      nextSeen.add(edge.to)
      visit(edge.to, nextSeen, nextPath)
    }
  }
  visit(start, new Set([start]), [])
  return paths
}

export const buildRouteChoices = (
  map: KcnavMapPayload,
  actualEdges: number[],
  target: string,
  limit = 64,
): number[][] => {
  const edgeMap = getEdgeMap(map)
  const starts = getStartNodes(map)
  // 实战中以最后一条实际边的终点为"当前位置"——实际走过的边不需要逐链校验
  // （能动分歧等特殊边可能不在 KCNav 拓扑里），游戏走过即事实
  if (actualEdges.length > 0) {
    const lastEdge = edgeMap.get(actualEdges[actualEdges.length - 1])
    if (lastEdge) {
      const current = lastEdge.to
      if (current === target) return [actualEdges]
      return enumeratePaths(map, current, target, limit).map((suffix) => [
        ...actualEdges,
        ...suffix,
      ])
    }
    // 最后一条边也不认识 → 落到计划模式全起点枚举
  }

  // 计划模式：从所有起点枚举
  const all: number[][] = []
  for (const start of starts) {
    for (const path of enumeratePaths(map, start, target, limit - all.length)) {
      all.push(path)
      if (all.length >= limit) return all
    }
  }
  return all
}

export const routeNodeSequence = (map: KcnavMapPayload, edgeIds: number[]): string[] => {
  const edgeMap = getEdgeMap(map)
  const nodes = [edgeMap.get(edgeIds[0] ?? -1)?.from ?? getStartNodes(map)[0]]
  for (const edgeId of edgeIds) {
    const edge = edgeMap.get(edgeId)
    if (edge) nodes.push(edge.to)
  }
  return nodes
}

export const routeLabel = (map: KcnavMapPayload, edgeIds: number[]): string =>
  routeNodeSequence(map, edgeIds).join(' → ')

export const getTargetOptions = (map: KcnavMapPayload): RouteEdge[] => {
  const byNode = new Map<string, RouteEdge>()
  for (const edge of getEdges(map)) {
    if (!ENEMY_NODE_TYPES.has(edge.nodeType)) continue
    const existing = byNode.get(edge.to)
    if (!existing || edge.nodeType === NODE_TYPE.Boss) byNode.set(edge.to, edge)
  }
  return [...byNode.values()].sort((a, b) => {
    const bossDiff = Number(b.nodeType === NODE_TYPE.Boss) - Number(a.nodeType === NODE_TYPE.Boss)
    return bossDiff || a.to.localeCompare(b.to)
  })
}

// 候选路线按「战斗边最小样本量」（人流瓶颈）降序；样本相同时战斗点少者优先。
// 只用本地样本数据，缺数据的边计 0；ignoreEdges（已走过的前缀）不参与瓶颈计算。
export const rankRoutesByTraffic = (
  map: KcnavMapPayload,
  routes: number[][],
  samples: Record<number, number>,
  ignoreEdges: ReadonlySet<number> = new Set(),
): number[][] => {
  const edgeMap = getEdgeMap(map)
  const scored = routes.map((route, index) => {
    const battleEdges = route.filter((edgeId) => {
      if (ignoreEdges.has(edgeId)) return false
      const edge = edgeMap.get(edgeId)
      return edge != null && ENEMY_NODE_TYPES.has(edge.nodeType)
    })
    const bottleneck = battleEdges.length
      ? Math.min(...battleEdges.map((edgeId) => samples[edgeId] ?? 0))
      : 0
    return { route, index, bottleneck, battles: battleEdges.length }
  })
  return scored
    .sort((a, b) =>
      b.bottleneck - a.bottleneck
      || a.battles - b.battles
      || a.index - b.index)
    .map((entry) => entry.route)
}

export const pickAutoTarget = (
  map: KcnavMapPayload,
  actualEdges: number[],
  samples?: Record<number, number>,
): string => {
  const options = getTargetOptions(map)
  const reachable = options.filter(
    (option) => buildRouteChoices(map, actualEdges, option.to).length > 0,
  )
  // 目标只在 boss 点之间选（无 boss 可达才退到战斗点），
  // 否则全体人流都会路过的道中点必然得分最高
  const bosses = reachable.filter((option) => option.nodeType === NODE_TYPE.Boss)
  const pool = bosses.length > 0 ? bosses : reachable
  // 有统计样本时选"同编成通过量最大"的目标：多 boss 图（战力/运输分属不同血条）
  // 按各目标入口边的样本求和评分——部分数据（只查了入口边）也能工作
  if (samples && pool.length > 1) {
    const entryEdges = getEdges(map)
    let best: { to: string; score: number } | null = null
    for (const option of pool) {
      const score = entryEdges
        .filter((edge) => edge.to === option.to)
        .reduce((sum, edge) => sum + (samples[edge.id] ?? 0), 0)
      if (score > 0 && (best == null || score > best.score)) {
        best = { to: option.to, score }
      }
    }
    if (best) return best.to
  }
  const boss = reachable.find((option) => option.nodeType === NODE_TYPE.Boss)
  return boss?.to ?? reachable[0]?.to ?? ''
}

export const getBattleEdges = (
  map: KcnavMapPayload,
  edgeIds: number[],
): RouteEdge[] => {
  const edgeMap = getEdgeMap(map)
  return edgeIds
    .map((id) => edgeMap.get(id))
    .filter((edge): edge is RouteEdge => !!edge && ENEMY_NODE_TYPES.has(edge.nodeType))
}

export const isWaitingAtChoice = (
  map: KcnavMapPayload,
  actualEdges: number[],
): boolean => {
  const edge = getEdgeMap(map).get(actualEdges.at(-1) ?? -1)
  return edge?.nodeType === NODE_TYPE.Choice
}

export interface SupplyTier {
  // 展示标签（不含百分比，百分比另行拼接以便复用）
  label: string
  // 相对"普通战斗"（=100%）的燃料/弹药消耗比例；数值取自 vendor 模拟器
  // engine/vendor/kcsim.js updateSupply() 的 newSupply 分支实测常量：
  // 普通 20%/20%、夜战 10%/10%、空袭 6%/4%（对应 30%/20%），
  // 均为 100% 战斗对应值的相对折算
  fuelPercent: number
  ammoPercent: number
  // 该档位是否只是"通常如此"而非引擎按节点类型强制（对潜点的免弹药实际由
  // 敌方是否为纯潜艇编成决定，不是节点类型本身——地图设计上对潜点几乎总是
  // 纯潜编成，但严格来说要看真实敌情）
  approximate?: boolean
}

const SUPPLY_TIER_NORMAL: SupplyTier = { label: '满额', fuelPercent: 100, ammoPercent: 100 }
const SUPPLY_TIER_NIGHT: SupplyTier = { label: '夜战·半额', fuelPercent: 50, ammoPercent: 50 }
const SUPPLY_TIER_AIR_RAID: SupplyTier = { label: '空袭·少量', fuelPercent: 30, ammoPercent: 20 }
const SUPPLY_TIER_SUB: SupplyTier = {
  label: '对潜·通常免弹药',
  fuelPercent: 40,
  ammoPercent: 0,
  approximate: true,
}

// 道中各类节点的油弹消耗档位，供玩家判断是否需要携带洋上补给（大发/给油给弹装置）。
// 只按节点类型区分——"航空战"(AirBattle) 与普通战斗一样按满额算：
// 引擎里只有 AirRaid（被空袭，无法还手）才会触发消耗折减，AirBattle 是正常战斗
// 只是双方以航空兵力交战，船只并未省下补给（这一点与"空袭"是两回事，容易搞混）
export const supplyTier = (nodeType: number): SupplyTier => {
  switch (nodeType) {
    case NODE_TYPE.NightBattle:
      return SUPPLY_TIER_NIGHT
    case NODE_TYPE.AirRaid:
      return SUPPLY_TIER_AIR_RAID
    case NODE_TYPE.SubStrike:
      return SUPPLY_TIER_SUB
    default:
      return SUPPLY_TIER_NORMAL
  }
}
