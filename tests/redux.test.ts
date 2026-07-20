import { describe, expect, it } from 'vitest'

import { reducer, setLbasStrikes, settleBattle, startSortie } from '../src/redux'

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
})
