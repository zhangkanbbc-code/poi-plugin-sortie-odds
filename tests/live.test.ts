import { describe, expect, it } from 'vitest'

import { initialState } from '../src/redux'
import {
  deriveLiveSortie,
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

  it('核心显示未出击时强制 active=false，即使自有状态说在出击', () => {
    const own = { ...initialState, active: true, mapId: '1-5', actualEdges: [3] }
    const live = deriveLiveSortie(own, {
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
