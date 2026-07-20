import { initialState } from '../redux'
import type { LiveSortieState } from '../types'

// poi 核心 state.sortie 的相关字段（views/redux/sortie）
export interface PoiSortieSlice {
  sortieMapId?: number | string
  sortieStatus?: boolean[]
  spotHistory?: number[]
}

// poi 核心 state.battle（views/redux/battle.js）：
// _status.battle 在战斗包到达时置对象、battleresult/进点/出击/回港时清 null，
// 是"战斗进行中"的权威信号（演习不经过该 reducer，不会误报）
export interface PoiBattleSlice {
  _status?: {
    battle?: unknown
    currentCell?: number
  }
}

export interface EventMapInfo {
  difficulty: number
  nowHp: number
  maxHp: number
  // api_gauge_type：2=战力(HP)，3=输送(TP)；0=未知
  gaugeType: number
  // 当前第几条血条/阶段（多血条图）
  gaugeNum: number
}

export type PoiEventMaps = Record<string, {
  api_eventmap?: {
    api_selected_rank?: number
    api_now_maphp?: number
    api_max_maphp?: number
    api_gauge_type?: number
    api_gauge_num?: number
  }
}>

// poi state.info.maps 以 `${area}${map}` 为键；活动图带 api_eventmap（难度与血条）
export const readEventMapInfo = (
  maps: PoiEventMaps | undefined,
  mapId: string,
): EventMapInfo | null => {
  const [area, map] = mapId.split('-')
  if (!area || !map || Number(area) < 10) return null
  const eventmap = maps?.[`${area}${map}`]?.api_eventmap
  if (!eventmap || typeof eventmap.api_selected_rank !== 'number') return null
  return {
    difficulty: eventmap.api_selected_rank,
    nowHp: Number(eventmap.api_now_maphp ?? 0),
    maxHp: Number(eventmap.api_max_maphp ?? 0),
    gaugeType: Number(eventmap.api_gauge_type ?? 0),
    gaugeNum: Number(eventmap.api_gauge_num ?? 0),
  }
}

// poi 的 sortie.combinedFlag 表示"家里是否编着联合舰队"，不代表本次出击形态：
// 联合在家时单独出第三舰队，flag 仍是 1。以实际出击舰队数为准
export const effectiveCombinedFlag = (
  fleetIds: number[],
  combinedFlag: number,
): number => (fleetIds.length > 1 ? combinedFlag : 0)

// 斩杀线各图不同且不可读，用 35% 作为保守分界：
// 血量偏低 → 取 [0, 当前血量] 的样本（斩杀形态为主）；
// 血量充足 → 取 [当前血量, 满血]（通常形态）
const KILL_ZONE_RATIO = 0.35

export const gaugeBandFor = (
  info: EventMapInfo | null,
): [number, number] | null => {
  if (!info || info.maxHp <= 0 || info.nowHp <= 0) return null
  return info.nowHp / info.maxHp <= KILL_ZONE_RATIO
    ? [0, info.nowHp]
    : [info.nowHp, info.maxHp]
}

// poi 把海域拼成 `${api_maparea_id}${api_mapinfo_no}` 字符串（如 '15'、'481'）；
// api_mapinfo_no 恒为个位数，所以末位是图号、其余是海域号
export const parseSortieMapId = (raw: unknown): string | null => {
  const text = String(raw ?? '')
  if (!/^\d{2,4}$/.test(text)) return null
  return `${text.slice(0, -1)}-${text.slice(-1)}`
}

// 海域、实际路线与战斗中状态以 poi 核心状态为准（不受插件加载时序影响）；
// 结算记账字段（lastRank/settlementAt/startedAt）仍来自自有 reducer。
// 例外：poi 中途重启（api_start2）会把核心 sortie 清零而游戏继续本次出击，
// 此时自有持久化记账（含完整已走前缀）才是权威，真正回港由 api_port/port 重置自有状态
export const deriveLiveSortie = (
  own: LiveSortieState | undefined,
  sortie: PoiSortieSlice | undefined,
  battle?: PoiBattleSlice,
): LiveSortieState => {
  const base = own ?? initialState
  const mapId = parseSortieMapId(sortie?.sortieMapId)
  const inSortie = mapId != null && (sortie?.sortieStatus ?? []).some(Boolean)
  if (!inSortie) {
    if (!base.active) return base
    // 自有记账仍在出击中：核心清零视为"重启后续走"，保持跟随；
    // 战斗中状态仍从核心 battle 派生（它在重启后照常工作）
    const ongoing = battle?._status !== undefined
      ? battle._status?.battle != null
      : base.battleOngoing
    return ongoing === base.battleOngoing ? base : { ...base, battleOngoing: ongoing }
  }
  const actualEdges = (sortie?.spotHistory ?? [])
    .slice(1)
    .filter((edge) => Number.isFinite(edge) && edge > 0)
  return {
    ...base,
    active: true,
    mapId,
    actualEdges,
    // 能走到第 N 个节点说明前 N-1 个节点必然已结算——不依赖事件记账的下界；
    // 自有记账（当前点结算后 = N）更新时取更大值
    completedEdgeCount: Math.max(
      base.completedEdgeCount,
      Math.max(0, actualEdges.length - 1),
    ),
    // 核心 battle 状态可用时覆盖自有记账（自有事件监听会错过重载前的战斗包）
    battleOngoing: battle?._status !== undefined
      ? battle._status?.battle != null
      : base.battleOngoing,
  }
}
