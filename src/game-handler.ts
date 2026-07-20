import { store } from 'views/create-store'

import { CONFIG_SWITCH_TO_PROPHET, PROPHET_PLUGIN_ID } from './constants'
import {
  appendEdge,
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

  if (path === '/kcsapi/api_port/port') {
    store.dispatch(resetSortie())
    return
  }

  if (path === '/kcsapi/api_req_map/start') {
    const area = Number(postBody?.api_maparea_id ?? body.api_maparea_id)
    const map = Number(postBody?.api_mapinfo_no ?? body.api_mapinfo_no)
    if (!Number.isFinite(area) || !Number.isFinite(map)) return
    store.dispatch(startSortie(`${area}-${map}`, toEdge(body.api_no)))
    return
  }

  if (path === '/kcsapi/api_req_map/start_air_base') {
    const strikes = [
      parseStrikePoints(postBody?.api_strike_point_1),
      parseStrikePoints(postBody?.api_strike_point_2),
      parseStrikePoints(postBody?.api_strike_point_3),
    ].filter((cells): cells is number[] => cells != null)
    if (strikes.length > 0) store.dispatch(setLbasStrikes(strikes))
    return
  }

  if (path === '/kcsapi/api_req_map/next') {
    const edge = toEdge(body.api_no)
    if (edge != null) store.dispatch(appendEdge(edge))
    return
  }

  if (path.endsWith('/battleresult')) {
    const rank = typeof body.api_win_rank === 'string' ? body.api_win_rank : ''
    if (!rank) return
    // 完成边数以 poi 核心 spotHistory 为准，避免 start 事件缺失时记账为 0
    const sortie = (store.getState() as { sortie?: PoiSortieSlice }).sortie
    const traversed = Math.max(0, (sortie?.spotHistory?.length ?? 0) - 1)
    store.dispatch(settleBattle(rank, traversed > 0 ? traversed : undefined))
  }
}

export const initHandler = (): void => {
  window.addEventListener('game.response', handleGameResponse)
}

export const destroyHandler = (): void => {
  window.removeEventListener('game.response', handleGameResponse)
  simulatorBridge.dispose()
}
