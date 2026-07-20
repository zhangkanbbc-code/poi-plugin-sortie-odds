import { describe, expect, it } from 'vitest'

import { initialState } from '../src/redux'
import {
  deriveLiveSortie,
  effectiveCombinedFlag,
  gaugeBandFor,
  parseSortieMapId,
  readEventMapInfo,
} from '../src/services/live'

describe('parseSortieMapId', () => {
  it('解析 poi 核心的 sortieMapId 拼接格式', () => {
    expect(parseSortieMapId('15')).toBe('1-5')
    expect(parseSortieMapId(15)).toBe('1-5')
    expect(parseSortieMapId('481')).toBe('48-1')
    expect(parseSortieMapId(342)).toBe('34-2')
  })

  it('未出击或非法值返回 null', () => {
    expect(parseSortieMapId(0)).toBeNull()
    expect(parseSortieMapId('0')).toBeNull()
    expect(parseSortieMapId(null)).toBeNull()
    expect(parseSortieMapId(undefined)).toBeNull()
    expect(parseSortieMapId('abc')).toBeNull()
  })
})

describe('readEventMapInfo', () => {
  const maps = {
    '481': {
      api_eventmap: {
        api_selected_rank: 4,
        api_now_maphp: 1300,
        api_max_maphp: 2000,
        api_gauge_type: 3,
        api_gauge_num: 2,
      },
    },
    '15': {},
  }

  it('活动图返回难度、血条、量表类型与期数', () => {
    expect(readEventMapInfo(maps, '48-1')).toEqual({
      difficulty: 4,
      nowHp: 1300,
      maxHp: 2000,
      gaugeType: 3,
      gaugeNum: 2,
    })
  })

  it('通常图或无数据返回 null', () => {
    expect(readEventMapInfo(maps, '1-5')).toBeNull()
    expect(readEventMapInfo(maps, '55-3')).toBeNull()
    expect(readEventMapInfo(undefined, '48-1')).toBeNull()
  })
})

describe('effectiveCombinedFlag', () => {
  it('单舰队出击时忽略家里的联合编队标记', () => {
    // 家里 1+2 编着机动部队(flag=1)，但实际出的是第三舰队单队
    expect(effectiveCombinedFlag([2], 1)).toBe(0)
  })

  it('联合出击时保留联合类型', () => {
    expect(effectiveCombinedFlag([0, 1], 1)).toBe(1)
    expect(effectiveCombinedFlag([0, 1], 3)).toBe(3)
  })
})

describe('gaugeBandFor', () => {
  const base = { difficulty: 4, gaugeType: 2, gaugeNum: 2 }

  it('血量 ≤35% 视为斩杀区间，取 [0, 当前血量]', () => {
    expect(gaugeBandFor({ ...base, nowHp: 600, maxHp: 2000 })).toEqual([0, 600])
  })

  it('血量充足时取 [当前血量, 满血]（通常形态样本）', () => {
    expect(gaugeBandFor({ ...base, nowHp: 1560, maxHp: 2000 })).toEqual([1560, 2000])
  })

  it('无血条数据返回 null', () => {
    expect(gaugeBandFor({ ...base, nowHp: 0, maxHp: 0 })).toBeNull()
    expect(gaugeBandFor(null)).toBeNull()
  })
})

describe('deriveLiveSortie', () => {
  it('出击中：海域与 edge 序列以 poi 核心状态为准', () => {
    const own = { ...initialState, lastRank: 'S', settlementAt: 123 }
    const live = deriveLiveSortie(own, {
      sortieMapId: '15',
      sortieStatus: [true, false, false, false],
      spotHistory: [0, 3, 7, 12],
    })
    expect(live.active).toBe(true)
    expect(live.mapId).toBe('1-5')
    expect(live.actualEdges).toEqual([3, 7, 12])
    // 自有的结算记账字段保留
    expect(live.lastRank).toBe('S')
    expect(live.settlementAt).toBe(123)
  })

  it('已完成节点数按"能走到第 N 点说明前 N-1 点已结算"派生', () => {
    // 自有结算记账失效（=0）时也能正确排除已打完的节点
    const live = deriveLiveSortie(initialState, {
      sortieMapId: '15',
      sortieStatus: [true, false, false, false],
      spotHistory: [0, 3, 7, 12],
    })
    expect(live.completedEdgeCount).toBe(2)
  })

  it('自有结算记账更新（当前点已结算）时以更大值为准', () => {
    const own = { ...initialState, completedEdgeCount: 3 }
    const live = deriveLiveSortie(own, {
      sortieMapId: '15',
      sortieStatus: [true, false, false, false],
      spotHistory: [0, 3, 7, 12],
    })
    expect(live.completedEdgeCount).toBe(3)
  })

  it('战斗中状态优先取 poi 核心 battle._status.battle（覆盖自有记账）', () => {
    const sortie = {
      sortieMapId: '15',
      sortieStatus: [true, false, false, false],
      spotHistory: [0, 3, 7],
    }
    // 核心说在打（对象非空）——即使自有记账错过了战斗包
    const fighting = deriveLiveSortie(initialState, sortie, { _status: { battle: {} } })
    expect(fighting.battleOngoing).toBe(true)
    // 核心说没在打（进点/结算后清 null）——即使自有记账残留 true
    const own = { ...initialState, battleOngoing: true }
    const idle = deriveLiveSortie(own, sortie, { _status: { battle: null } })
    expect(idle.battleOngoing).toBe(false)
    // 核心 battle 状态不可用时退回自有记账
    const fallback = deriveLiveSortie(own, sortie)
    expect(fallback.battleOngoing).toBe(true)
  })

  it('spotHistory 首位是起点格，会被剔除；0 值边被过滤', () => {
    const live = deriveLiveSortie(initialState, {
      sortieMapId: '25',
      sortieStatus: [true, false, false, false],
      spotHistory: [1, 4, 0, 9],
    })
    expect(live.actualEdges).toEqual([4, 9])
  })

  it('演习（sortieStatus 有 true 但 sortieMapId 为 0）不算出击', () => {
    const live = deriveLiveSortie(initialState, {
      sortieMapId: 0,
      sortieStatus: [true, false, false, false],
      spotHistory: [],
    })
    expect(live.active).toBe(false)
  })

  it('poi 中途重启（核心 sortie 被清零）时以自有持久化记账为准，保持跟随', () => {
    // api_start2 清空核心 sortie 但游戏可续走本次出击（poi 核心源码注释明示此场景）
    const own = {
      ...initialState,
      active: true,
      mapId: '62-3',
      actualEdges: [3, 7, 12],
      completedEdgeCount: 2,
    }
    const live = deriveLiveSortie(own, {
      sortieMapId: 0,
      sortieStatus: [false, false, false, false],
      spotHistory: [],
    })
    expect(live.active).toBe(true)
    expect(live.mapId).toBe('62-3')
    expect(live.actualEdges).toEqual([3, 7, 12])
  })

  it('中途重启的跟随中，战斗中状态仍从核心 battle 派生', () => {
    const own = { ...initialState, active: true, mapId: '62-3', actualEdges: [3] }
    const cleared = {
      sortieMapId: 0,
      sortieStatus: [false, false, false, false],
      spotHistory: [],
    }
    expect(deriveLiveSortie(own, cleared, { _status: { battle: {} } }).battleOngoing).toBe(true)
    expect(deriveLiveSortie(own, cleared, { _status: { battle: null } }).battleOngoing).toBe(false)
  })

  it('自有状态也未出击时保持 inactive（真正在母港）', () => {
    const live = deriveLiveSortie(initialState, {
      sortieMapId: 0,
      sortieStatus: [false, false, false, false],
      spotHistory: [],
    })
    expect(live.active).toBe(false)
  })

  it('无 own 状态（reducer 未注册）时也能工作', () => {
    const live = deriveLiveSortie(undefined, {
      sortieMapId: '15',
      sortieStatus: [true, false, false, false],
      spotHistory: [0, 3],
    })
    expect(live.active).toBe(true)
    expect(live.mapId).toBe('1-5')
    expect(live.actualEdges).toEqual([3])
  })
})
