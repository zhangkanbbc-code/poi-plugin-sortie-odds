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
  // 实战中以第一条实际边的出发点为锚（多起点图由此自动锁定真实起点）
  const anchorStart = actualEdges.length
    ? (edgeMap.get(actualEdges[0])?.from ?? null)
    : null

  if (anchorStart) {
    const validActual: number[] = []
    let current = anchorStart
    for (const edgeId of actualEdges) {
      const edge = edgeMap.get(edgeId)
      if (!edge || edge.from !== current) break
      validActual.push(edgeId)
      current = edge.to
    }
    if (current === target) return [validActual]
    return enumeratePaths(map, current, target, limit).map((suffix) => [
      ...validActual,
      ...suffix,
    ])
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

export const routeLabel = (map: KcnavMapPayload, edgeIds: number[]): string => {
  const edgeMap = getEdgeMap(map)
  const nodes = [edgeMap.get(edgeIds[0] ?? -1)?.from ?? getStartNodes(map)[0]]
  for (const edgeId of edgeIds) {
    const edge = edgeMap.get(edgeId)
    if (edge) nodes.push(edge.to)
  }
  return nodes.join(' → ')
}

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
