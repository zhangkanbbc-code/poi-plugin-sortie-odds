import { describe, expect, it } from 'vitest'

import {
  appendEdge,
  markBattleStart,
  reducer,
  setLbasStrikes,
  settleBattle,
  startSortie,
} from '../src/redux'

describe('sortie settlement state', () => {
  it('marks all entered edges complete when a battle result arrives', () => {
    const started = reducer(undefined, startSortie('1-1', 1))
    const settled = reducer(started, settleBattle('S'))
    expect(settled.completedEdgeCount).toBe(1)
    expect(settled.lastRank).toBe('S')
    expect(settled.settlementAt).toBeGreaterThan(0)
  })

  it('记录基航实际派遣，新出击时清空', () => {
    const started = reducer(undefined, startSortie('62-3', 1))
    const withStrikes = reducer(started, setLbasStrikes([[12, 12], [12, 14]]))
    expect(withStrikes.lbasStrikes).toEqual([[12, 12], [12, 14]])
    const restarted = reducer(withStrikes, startSortie('62-3', 1))
    expect(restarted.lbasStrikes).toBeNull()
  })

  it('handler 显式传入完成边数时以它为准（start 事件缺失的场合）', () => {
    // 未捕获 start 时自有 actualEdges 为空，结算数取自 poi 核心 spotHistory
    const settled = reducer(undefined, settleBattle('A', 3))
    expect(settled.completedEdgeCount).toBe(3)
    expect(settled.lastRank).toBe('A')
  })

  it('战斗中标记：战斗包置位，结算清除', () => {
    const started = reducer(undefined, startSortie('62-3', 1))
    expect(started.battleOngoing).toBe(false)
    const fighting = reducer(started, markBattleStart())
    expect(fighting.battleOngoing).toBe(true)
    const settled = reducer(fighting, settleBattle('S'))
    expect(settled.battleOngoing).toBe(false)
  })

  it('战斗中标记：进入新节点即清除（到点重算不能被上一战的残留堵住）', () => {
    const started = reducer(undefined, startSortie('62-3', 1))
    const fighting = reducer(started, markBattleStart())
    const moved = reducer(fighting, appendEdge(5))
    expect(moved.battleOngoing).toBe(false)
    expect(moved.actualEdges).toEqual([1, 5])
  })
})
