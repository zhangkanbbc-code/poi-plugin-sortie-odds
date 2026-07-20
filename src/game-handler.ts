import { store } from 'views/create-store'

import { CONFIG_SWITCH_TO_PROPHET, PLUGIN_KEY, PROPHET_PLUGIN_ID } from './constants'
import {
  LIVE_CONFIG_PATH,
  appendEdge,
  markBattleStart,
  resetSortie,
  setLbasStrikes,
  settleBattle,
  startSortie,
} from './redux'
import { simulatorBridge } from './services/simulator'
import type { PoiSortieSlice } from './services/live'

interface MapResponseBody {
  api_maparea_id?: number
  api_mapinfo_no?: number
  api_no?: number
  api_win_rank?: string
}

// api_req_map/start 的海域号只保证在请求体里（poi 核心也是读 postBody）
interface MapRequestBody {
  api_maparea_id?: number | string
  api_mapinfo_no?: number | string
  // api_req_map/start_air_base：各基地两波的目标格子号，如 "12,14"
  api_strike_point_1?: string | number
  api_strike_point_2?: string | number
  api_strike_point_3?: string | number
}

const parseStrikePoints = (value: string | number | undefined): number[] | null => {
  if (value == null) return null
  const cells = String(value)
    .split(',')
    .map(Number)
    .filter((cell) => Number.isFinite(cell) && cell > 0)
  return cells.length > 0 ? cells : null
}

interface GameResponseDetail {
  path: string
  body: MapResponseBody
  postBody?: MapRequestBody
}

const toEdge = (value: unknown): number | null => {
  const edge = Number(value)
  return Number.isFinite(edge) && edge > 0 ? edge : null
}

type ExtState = { ext?: Record<string, { actualEdges?: number[] } | undefined> }

// 记账动作后立刻持久化：poi 重启（api_start2）会清空核心 sortie 状态，
// 但游戏能中途续走——恢复靠这份存档（见 redux.restoreLiveState）
const sync = (action: Parameters<typeof store.dispatch>[0]): void => {
  store.dispatch(action)
  try {
    const live = (store.getState() as ExtState).ext?.[PLUGIN_KEY]
    if (live) window.config?.set(LIVE_CONFIG_PATH, live)
  } catch {
    // 配置写失败不阻断游戏事件处理
  }
}

// 战斗系响应（不含结算/回港）：昼战/夜战/空袭战/联合舰队各形态的首个战斗包
const BATTLE_PATH = /^\/kcsapi\/api_req_(sortie|battle_midnight|combined_battle)\//
const NON_BATTLE_SUFFIX = /(battleresult|goback_port)$/

// 进战斗时把面板切回未卜先知（地图移动仍由 switchPluginPath 切到本插件），
// 形成"移动看胜率、开打看战况"的循环；可在面板里关闭
const switchToProphetOnBattle = (path: string): void => {
  if (!BATTLE_PATH.test(path) || NON_BATTLE_SUFFIX.test(path)) return
  if (window.config?.get(CONFIG_SWITCH_TO_PROPHET, true) === false) return
  const state = store.getState()
  if (window.config?.get('poi.autoswitch.enabled', true) === false) return
  const prophet = state.plugins?.find((plugin) => plugin.id === PROPHET_PLUGIN_ID)
  if (!prophet?.enabled) return
  const doubleTabbed = Boolean(state.config?.poi?.tabarea?.double)
  store.dispatch({
    type: '@@TabSwitch',
    tabInfo: doubleTabbed
      ? { activePluginName: PROPHET_PLUGIN_ID }
      : { activeMainTab: PROPHET_PLUGIN_ID, activePluginName: PROPHET_PLUGIN_ID },
    autoSwitch: true,
  })
}

const handleGameResponse = (event: Event): void => {
  const { path, body, postBody } = (event as CustomEvent<GameResponseDetail>).detail
  if (!body) return

  switchToProphetOnBattle(path)

  // 战斗中标记：首个战斗包置位，battleresult/进点/回港清除（见 redux 各 case）。
  // 重算门控靠它精确暂停在"开打→结算"区间，而不是整个"到点→结算"
  if (BATTLE_PATH.test(path) && !NON_BATTLE_SUFFIX.test(path)) {
    store.dispatch(markBattleStart())
  }

  if (path === '/kcsapi/api_port/port') {
    sync(resetSortie())
    return
  }

  if (path === '/kcsapi/api_req_map/start') {
    const area = Number(postBody?.api_maparea_id ?? body.api_maparea_id)
    const map = Number(postBody?.api_mapinfo_no ?? body.api_mapinfo_no)
    if (!Number.isFinite(area) || !Number.isFinite(map)) return
    sync(startSortie(`${area}-${map}`, toEdge(body.api_no)))
    return
  }

  if (path === '/kcsapi/api_req_map/start_air_base') {
    const strikes = [
      parseStrikePoints(postBody?.api_strike_point_1),
      parseStrikePoints(postBody?.api_strike_point_2),
      parseStrikePoints(postBody?.api_strike_point_3),
    ].filter((cells): cells is number[] => cells != null)
    if (strikes.length > 0) sync(setLbasStrikes(strikes))
    return
  }

  if (path === '/kcsapi/api_req_map/next') {
    const edge = toEdge(body.api_no)
    if (edge != null) sync(appendEdge(edge))
    return
  }

  if (path.endsWith('/battleresult')) {
    const rank = typeof body.api_win_rank === 'string' ? body.api_win_rank : ''
    if (!rank) return
    // 完成边数取核心 spotHistory 与自有记账的较大值：
    // poi 中途重启后核心被截断，自有恢复的路径才是全量
    const state = store.getState() as { sortie?: PoiSortieSlice } & ExtState
    const coreTraversed = Math.max(0, (state.sortie?.spotHistory?.length ?? 0) - 1)
    const ownTraversed = state.ext?.[PLUGIN_KEY]?.actualEdges?.length ?? 0
    const traversed = Math.max(coreTraversed, ownTraversed)
    sync(settleBattle(rank, traversed > 0 ? traversed : undefined))
  }
}

export const initHandler = (): void => {
  window.addEventListener('game.response', handleGameResponse)
}

export const destroyHandler = (): void => {
  window.removeEventListener('game.response', handleGameResponse)
  simulatorBridge.dispose()
}
