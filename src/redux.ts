import { PLUGIN_KEY } from './constants'
import type { LiveSortieState } from './types'

const START = `@@${PLUGIN_KEY}/start`
const EDGE = `@@${PLUGIN_KEY}/edge`
const RESET = `@@${PLUGIN_KEY}/reset`
const SETTLEMENT = `@@${PLUGIN_KEY}/settlement`
const LBAS_STRIKES = `@@${PLUGIN_KEY}/lbas-strikes`
const BATTLE_START = `@@${PLUGIN_KEY}/battle-start`

const defaultState: LiveSortieState = {
  active: false,
  mapId: null,
  actualEdges: [],
  startedAt: 0,
  completedEdgeCount: 0,
  lastRank: null,
  settlementAt: 0,
  updatedAt: 0,
  lbasStrikes: null,
  battleOngoing: false,
}

// poi 重启（游戏重载）会触发 api_start2，核心 sortie 状态被清零，
// 但游戏可以中途续走本次出击——自有记账持久化到 poi config，
// 插件加载时恢复未过期的出击；真正回港由 api_port/port 重置
export const LIVE_CONFIG_PATH = `plugin.${PLUGIN_KEY}.liveSortie`
const RESTORE_MAX_AGE_MS = 12 * 3600 * 1000

export const restoreLiveState = (
  saved: Partial<LiveSortieState> | undefined,
  now = Date.now(),
): LiveSortieState => {
  if (!saved?.active) return defaultState
  const startedAt = Number(saved.startedAt ?? 0)
  if (!(startedAt > 0) || now - startedAt > RESTORE_MAX_AGE_MS) return defaultState
  return {
    ...defaultState,
    ...saved,
    actualEdges: Array.isArray(saved.actualEdges)
      ? saved.actualEdges.filter((edge) => Number.isFinite(edge) && edge > 0)
      : [],
    // 战斗中状态不恢复——重启后由核心 state.battle 实时派生
    battleOngoing: false,
  }
}

export const initialState: LiveSortieState = (() => {
  try {
    if (typeof window !== 'undefined' && window.config) {
      return restoreLiveState(
        window.config.get(LIVE_CONFIG_PATH) as Partial<LiveSortieState> | undefined,
      )
    }
  } catch {
    // 配置不可读时按未出击处理
  }
  return defaultState
})()

export const startSortie = (mapId: string, edge: number | null) => ({
  type: START,
  mapId,
  edge,
})

export const appendEdge = (edge: number) => ({ type: EDGE, edge })
export const resetSortie = () => ({ type: RESET })
export const setLbasStrikes = (strikes: number[][]) => ({
  type: LBAS_STRIKES,
  strikes,
})
export const settleBattle = (rank: string, completedEdges?: number) => ({
  type: SETTLEMENT,
  rank,
  completedEdges,
})
export const markBattleStart = () => ({ type: BATTLE_START })

type SortieAction =
  | ReturnType<typeof startSortie>
  | ReturnType<typeof appendEdge>
  | ReturnType<typeof resetSortie>
  | ReturnType<typeof settleBattle>
  | ReturnType<typeof setLbasStrikes>
  | ReturnType<typeof markBattleStart>
  | { type: string }

export const reducer = (
  state: LiveSortieState = initialState,
  action: SortieAction,
): LiveSortieState => {
  switch (action.type) {
    case START: {
      const start = action as ReturnType<typeof startSortie>
      const now = Date.now()
      return {
        active: true,
        mapId: start.mapId,
        actualEdges: start.edge == null ? [] : [start.edge],
        startedAt: now,
        completedEdgeCount: 0,
        lastRank: null,
        settlementAt: 0,
        updatedAt: now,
        lbasStrikes: null,
        battleOngoing: false,
      }
    }
    case LBAS_STRIKES: {
      const strikes = action as ReturnType<typeof setLbasStrikes>
      return { ...state, lbasStrikes: strikes.strikes, updatedAt: Date.now() }
    }
    case BATTLE_START:
      return state.battleOngoing ? state : { ...state, battleOngoing: true, updatedAt: Date.now() }
    case SETTLEMENT: {
      const settlement = action as ReturnType<typeof settleBattle>
      return {
        ...state,
        // 取 max：poi 中途重启后核心 spotHistory 被截断，传入值可能小于已知进度
        completedEdgeCount: Math.max(
          state.completedEdgeCount,
          settlement.completedEdges ?? state.actualEdges.length,
        ),
        lastRank: settlement.rank,
        settlementAt: Date.now(),
        updatedAt: Date.now(),
        battleOngoing: false,
      }
    }
    case EDGE: {
      const next = action as ReturnType<typeof appendEdge>
      if (state.actualEdges.at(-1) === next.edge) return state
      return {
        ...state,
        active: true,
        actualEdges: [...state.actualEdges, next.edge],
        updatedAt: Date.now(),
        battleOngoing: false,
      }
    }
    case RESET:
      // 回到干净默认态（initialState 可能带着恢复的出击）
      return { ...defaultState, updatedAt: Date.now() }
    default:
      return state
  }
}
