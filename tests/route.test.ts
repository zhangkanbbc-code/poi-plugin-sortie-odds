import { describe, expect, it } from 'vitest'

import {
  buildRouteChoices,
  enumeratePaths,
  getBattleEdges,
  getStartNodes,
  pickAutoTarget,
  rankRoutesByTraffic,
  routeLabel,
} from '../src/services/route'
import type { KcnavMapPayload } from '../src/types'

const map: KcnavMapPayload = {
  result: {
    route: {
      '0': [null, '1', 0, 0],
      '1': ['1', 'A', 4, 4],
      '2': ['A', 'B', 91, 91],
      '3': ['B', 'C', 4, 4],
      '4': ['B', 'D', 4, 4],
      '5': ['C', 'Z', 5, 5],
      '6': ['D', 'Z', 5, 5],
      '7': ['C', 'A', 4, 4],
    },
  },
}

describe('route helpers', () => {
  it('enumerates simple paths and ignores cycles', () => {
    expect(enumeratePaths(map, '1', 'Z')).toEqual([
      [1, 2, 3, 5],
      [1, 2, 4, 6],
    ])
  })

  it('keeps the actual prefix after a manual branch', () => {
    expect(buildRouteChoices(map, [1, 2, 4], 'Z')).toEqual([[1, 2, 4, 6]])
  })

  it('formats labels and keeps only battle nodes', () => {
    expect(routeLabel(map, [1, 2, 3, 5])).toBe('1 → A → B → C → Z')
    expect(getBattleEdges(map, [1, 2, 3, 5]).map((edge) => edge.to)).toEqual([
      'A',
      'C',
      'Z',
    ])
  })
})

describe('pickAutoTarget', () => {
  // 双 boss 图：走 3 号边后只能到 Y，走 4 号边后只能到 Z
  const twinBossMap: KcnavMapPayload = {
    result: {
      route: {
        '0': [null, '1', 0, 0],
        '1': ['1', 'A', 4, 4],
        '2': ['A', 'B', 91, 91],
        '3': ['B', 'C', 4, 4],
        '4': ['B', 'D', 4, 4],
        '5': ['C', 'Y', 5, 5],
        '6': ['D', 'Z', 5, 5],
      },
    },
  }

  it('未出击时选第一个可达 boss', () => {
    expect(pickAutoTarget(twinBossMap, [])).toBe('Y')
  })

  it('实际路线锁定分支后自动换成可达的 boss', () => {
    expect(pickAutoTarget(twinBossMap, [1, 2, 4])).toBe('Z')
  })

  it('没有可达 boss 时退回第一个可达战斗点', () => {
    // 只有战斗点没有 boss 的图
    const noBossMap: KcnavMapPayload = {
      result: {
        route: {
          '0': [null, '1', 0, 0],
          '1': ['1', 'A', 4, 4],
          '2': ['A', 'B', 4, 4],
        },
      },
    }
    expect(pickAutoTarget(noBossMap, [])).toBe('A')
  })

  it('没有任何可达目标时返回空串', () => {
    const emptyMap: KcnavMapPayload = {
      result: { route: { '0': [null, '1', 0, 0] } },
    }
    expect(pickAutoTarget(emptyMap, [])).toBe('')
  })

  it('带样本时选统计人流最大的 boss（运输期选运输 boss）', () => {
    // O 和 Q 都是 boss；当前期数的样本全部通向 Q
    const twinBossPhaseMap: KcnavMapPayload = {
      result: {
        route: {
          '0': [null, '1', 0, 0],
          '1': ['1', 'A', 4, 4],
          '2': ['A', 'O', 5, 5],
          '3': ['A', 'B', 4, 4],
          '4': ['B', 'Q', 5, 5],
        },
      },
    }
    const samples = { 1: 5000, 2: 3, 3: 4800, 4: 4700 }
    expect(pickAutoTarget(twinBossPhaseMap, [], samples)).toBe('Q')
    // 无样本时回退 boss 字母序
    expect(pickAutoTarget(twinBossPhaseMap, [])).toBe('O')
    // 样本全零同样回退
    expect(pickAutoTarget(twinBossPhaseMap, [], { 1: 0, 2: 0, 3: 0, 4: 0 })).toBe('O')
  })
})

describe('multi-start maps', () => {
  // 仿活动图：起点 1 走 A→Z，起点 2 走 B→Z
  const multiStartMap: KcnavMapPayload = {
    result: {
      route: {
        '0': [null, '1', 0, 0],
        '5': [null, '2', 0, 0],
        '1': ['1', 'A', 4, 4],
        '2': ['A', 'Z', 5, 5],
        '3': ['2', 'B', 4, 4],
        '4': ['B', 'Z', 5, 5],
      },
    },
  }

  it('getStartNodes 返回全部起点', () => {
    expect(getStartNodes(multiStartMap)).toEqual(['1', '2'])
  })

  it('计划模式从所有起点枚举候选路线', () => {
    expect(buildRouteChoices(multiStartMap, [], 'Z')).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('实战锁定第二起点的路线前缀', () => {
    expect(buildRouteChoices(multiStartMap, [3], 'Z')).toEqual([[3, 4]])
  })

  it('routeLabel 按路线实际起点渲染', () => {
    expect(routeLabel(multiStartMap, [3, 4])).toBe('2 → B → Z')
    expect(routeLabel(multiStartMap, [1, 2])).toBe('1 → A → Z')
  })

  it('pickAutoTarget 覆盖所有起点可达的 boss', () => {
    expect(pickAutoTarget(multiStartMap, [3])).toBe('Z')
  })
})

describe('rankRoutesByTraffic', () => {
  // 仿 1-5：E→C(3) 是冷门水面点，E→J(11) 是人流主路
  const map: KcnavMapPayload = {
    result: {
      route: {
        '0': [null, '1', 0, 0],
        '1': ['1', 'A', 4, 4],
        '2': ['C', 'B', 90, 6],
        '3': ['E', 'C', 4, 4],
        '4': ['A', 'D', 4, 4],
        '5': ['D', 'E', 4, 4],
        '10': ['C', 'J', 5, 5],
        '11': ['E', 'J', 5, 5],
      },
    },
  }
  const samples = { 1: 173300, 3: 733, 4: 170453, 5: 50922, 10: 39, 11: 46500 }

  it('按瓶颈样本量降序：人流主路排最前', () => {
    const routes = [
      [1, 4, 5, 3, 10],
      [1, 4, 5, 11],
    ]
    expect(rankRoutesByTraffic(map, routes, samples)).toEqual([
      [1, 4, 5, 11],
      [1, 4, 5, 3, 10],
    ])
  })

  it('非战斗边不参与瓶颈计算', () => {
    // edge 2 (C→B) 是通过点，无样本数据也不应拖累路线
    const routes = [[1, 4, 5, 3, 2]]
    const ranked = rankRoutesByTraffic(map, routes, samples)
    expect(ranked).toEqual([[1, 4, 5, 3, 2]])
  })

  it('样本全缺时保持原顺序、战斗点少者优先', () => {
    const routes = [
      [1, 4, 5, 3, 10],
      [1, 4, 5, 11],
    ]
    expect(rankRoutesByTraffic(map, routes, {})).toEqual([
      [1, 4, 5, 11],
      [1, 4, 5, 3, 10],
    ])
  })

  it('ignoreEdges（已走过的前缀）不参与瓶颈计算', () => {
    // 前缀边 1、4 没有同编成数据（值为 0），但已实际走过，不应把两条路线都归零
    const compCounts = { 3: 0, 10: 0, 11: 320 }
    const routes = [
      [1, 4, 5, 3, 10],
      [1, 4, 5, 11],
    ]
    expect(
      rankRoutesByTraffic(map, routes, compCounts, new Set([1, 4, 5])),
    ).toEqual([
      [1, 4, 5, 11],
      [1, 4, 5, 3, 10],
    ])
  })
})
