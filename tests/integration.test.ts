import { describe, expect, it } from 'vitest'

import {
  applyProphetSettlement,
  completedEdgeCountFromLogs,
  prophetBattleFingerprint,
  readPluginIntegrations,
} from '../src/services/integration'
import type { KcnavMapPayload, PoiFleetSnapshot } from '../src/types'

describe('plugin integrations', () => {
  it('reads the latest Akashic Records settlement', () => {
    const state = {
      ext: {
        'poi-plugin-akashic-records': {
          attack: {
            data: [[1234, '鎮守府正面海域(1-1)', 'C(Boss点)', '進撃', '勝利A']],
          },
        },
        'poi-plugin-prophet': { battle: { result: { rank: 'A' } } },
      },
    } as unknown as PoiRootState
    const result = readPluginIntegrations(state)
    expect(result.prophetAvailable).toBe(true)
    expect(result.latestAkashic).toEqual({
      timestamp: 1234,
      mapId: '1-1',
      node: 'C',
      rank: 'A',
    })
  })

  it('uses Prophet post-battle HP only for the matching result', () => {
    const snapshot: PoiFleetSnapshot = {
      fleetIds: [0],
      fleets: [[[
        { api_id: 101, api_ship_id: 1, api_lv: 1, api_nowhp: 30, api_maxhp: 30 },
        { api_id: 1, api_stype: 2 },
      ]]],
      equips: [[[]]],
      combinedFlag: 0,
    }
    const applied = applyProphetSettlement(snapshot, {
      mainFleet: [{ nowHP: 7, raw: { api_id: 101 } }],
      result: { rank: 'B' },
    }, 'B')
    expect(applied.appliedShips).toBe(1)
    expect(applied.snapshot.fleets[0][0]?.[0].api_nowhp).toBe(7)
    expect(applyProphetSettlement(snapshot, { result: { rank: 'A' } }, 'B').appliedShips).toBe(0)
  })

  it('changes the Prophet fingerprint when battle HP changes', () => {
    const first = prophetBattleFingerprint({
      sortieState: 2,
      mainFleet: [{ nowHP: 20, raw: { api_id: 101 } }],
      result: { rank: 'A' },
    })
    const second = prophetBattleFingerprint({
      sortieState: 2,
      mainFleet: [{ nowHP: 8, raw: { api_id: 101 } }],
      result: { rank: 'A' },
    })
    expect(first).not.toBe(second)
  })

  it('marks the logged node and all prior edges complete', () => {
    const map: KcnavMapPayload = {
      result: { route: {
        '0': [null, '1', 0, 0],
        '1': ['1', 'A', 4, 4],
        '2': ['A', 'B', 4, 4],
        '3': ['B', 'C', 5, 5],
      } },
    }
    expect(completedEdgeCountFromLogs(map, [1, 2], '1-1', 1, {
      timestamp: 1234,
      mapId: '1-1',
      node: 'B',
      rank: 'S',
    }, 1000)).toBe(2)
    expect(completedEdgeCountFromLogs(map, [1, 2], '1-1', 1, {
      timestamp: 999,
      mapId: '1-1',
      node: 'B',
      rank: 'S',
    }, 1000)).toBe(1)
    // 结算记账全丢时也有"前 N-1 点已结算"下界（视图边界兜底）
    expect(completedEdgeCountFromLogs(map, [1, 2], '1-1', 0, null, 0)).toBe(1)
    expect(completedEdgeCountFromLogs(map, [], '1-1', 0, null, 0)).toBe(0)
  })
})
