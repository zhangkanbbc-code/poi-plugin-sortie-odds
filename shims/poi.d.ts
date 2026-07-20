declare global {
  interface Window {
    APPDATA_PATH?: string
    config?: {
      get: (path: string, defaultValue?: unknown) => unknown
      set: (path: string, value?: unknown) => void
    }
  }

  interface PoiRootState {
    sortie?: {
      sortieStatus?: boolean[]
      combinedFlag?: number
      sortieMapId?: number | string
      spotHistory?: number[]
    }
    // views/redux/battle.js：_status.battle 非空 = 战斗进行中
    battle?: {
      _status?: {
        battle?: unknown
        currentCell?: number
      }
    }
    info?: {
      fleets?: Array<{ api_ship?: number[]; api_mission?: number[] }>
      basic?: { api_level?: number }
      maps?: Record<string, unknown>
      airbase?: unknown[]
      equips?: Record<string, unknown>
    }
    ext?: Record<string, unknown>
    plugins?: Array<{ id?: string; enabled?: boolean }>
    config?: { poi?: { tabarea?: { double?: boolean } } }
  }
}

export {}
