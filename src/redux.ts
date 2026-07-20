import { PLUGIN_KEY } from './constants'
import type { LiveSortieState } from './types'

const START = `@@${PLUGIN_KEY}/start`
const EDGE = `@@${PLUGIN_KEY}/edge`
const RESET = `@@${PLUGIN_KEY}/reset`
const SETTLEMENT = `@@${PLUGIN_KEY}/settlement`
const LBAS_STRIKES = `@@${PLUGIN_KEY}/lbas-strikes`

export const initialState: LiveSortieState = {
  active: false,
  mapId: null,
  actualEdges: [],
  startedAt: 0,
  completedEdgeCount: 0,
  lastRank: null,
  settlementAt: 0,
  updatedAt: 0,
  lbasStrikes: null,
}

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

type SortieAction =
  | ReturnType<typeof startSortie>
  | ReturnType<typeof appendEdge>
  | ReturnType<typeof resetSortie>
  | ReturnType<typeof settleBattle>
  | ReturnType<typeof setLbasStrikes>
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
      }
    }
    case LBAS_STRIKES: {
      const strikes = action as ReturnType<typeof setLbasStrikes>
      return { ...state, lbasStrikes: strikes.strikes, updatedAt: Date.now() }
    }
    case SETTLEMENT: {
      const settlement = action as ReturnType<typeof settleBattle>
      return {
        ...state,
        completedEdgeCount: settlement.completedEdges ?? state.actualEdges.length,
        lastRank: settlement.rank,
        settlementAt: Date.now(),
        updatedAt: Date.now(),
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
      }
    }
    case RESET:
      return { ...initialState, updatedAt: Date.now() }
    default:
      return state
  }
}
