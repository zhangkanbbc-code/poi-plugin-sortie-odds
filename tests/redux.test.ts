import { describe, expect, it } from 'vitest'

import {
  appendEdge,
  initialState,
  markBattleStart,
  reducer,
  restoreLiveState,
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

  it('结算不回退已完成边数（poi 中途重启后核心 spotHistory 被截断的场合）', () => {
    const state = {
      ...initialState,
      active: true,
      actualEdges: [1, 2, 3, 4, 5],
      completedEdgeCount: 4,
    }
    // 核心截断后 handler 只能算出 1，取 max 保住已知进度
    expect(reducer(state, settleBattle('A', 1)).completedEdgeCount).toBe(4)
    expect(reducer(state, settleBattle('S', 5)).completedEdgeCount).toBe(5)
  })
})

describe('restoreLiveState（poi 重启后恢复出击记账）', () => {
  const now = 1_700_000_000_000
  const saved = {
    active: true,
    mapId: '62-3',
    actualEdges: [3, 7, 12],
    startedAt: now - 30 * 60 * 1000,
    completedEdgeCount: 2,
    battleOngoing: true,
  }

  it('未过期的出击恢复完整路径，battleOngoing 不恢复', () => {
    const restored = restoreLiveState(saved, now)
    expect(restored.active).toBe(true)
    expect(restored.mapId).toBe('62-3')
    expect(restored.actualEdges).toEqual([3, 7, 12])
    expect(restored.completedEdgeCount).toBe(2)
    expect(restored.battleOngoing).toBe(false)
  })

  it('超过 12 小时的存档不恢复（出击不可能跨半天）', () => {
    const stale = { ...saved, startedAt: now - 13 * 3600 * 1000 }
    expect(restoreLiveState(stale, now).active).toBe(false)
  })

  it('未出击/缺失/损坏的存档回落默认态', () => {
    expect(restoreLiveState(undefined, now).active).toBe(false)
    expect(restoreLiveState({ active: false }, now).active).toBe(false)
    expect(restoreLiveState({ active: true, startedAt: 0 }, now).active).toBe(false)
    const badEdges = restoreLiveState(
      { ...saved, actualEdges: 'garbage' as unknown as number[] },
      now,
    )
    expect(badEdges.actualEdges).toEqual([])
  })
})
