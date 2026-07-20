import { describe, expect, it } from 'vitest'

import { getRoutingFleetFeatures, routingFeatureLabel } from '../src/services/reachability'
import type { PoiFleetSnapshot, PoiShipEntry } from '../src/types'

const ship = (stype: number): PoiShipEntry => [
  { api_ship_id: 1, api_lv: 1, api_nowhp: 1, api_maxhp: 1 },
  { api_id: 1, api_stype: stype },
]

const baseSnapshot: PoiFleetSnapshot = {
  fleetIds: [0, 1],
  fleets: [[ship(2), ship(3)], [ship(2), ship(2)]],
  equips: [
    [
      [[{ api_slotitem_id: 28 }, { api_id: 28 }, undefined]],
      [
        undefined as unknown as PoiFleetSnapshot['equips'][number][number][number],
        [{ api_slotitem_id: 75 }, { api_id: 75 }, undefined],
      ],
    ],
    [
      [[{ api_slotitem_id: 30 }, { api_id: 30 }, undefined]],
      [],
    ],
  ],
  combinedFlag: 2,
}

describe('routing fleet features', () => {
  it('builds KCNav class filters and counts routing equipment', () => {
    const snapshot: PoiFleetSnapshot = { ...baseSnapshot, speed: 10, hqLevel: 110 }

    const result = getRoutingFleetFeatures(snapshot)
    expect(result).toEqual({
      fleetType: 2,
      fleetNum: 1,
      mainComp: 'DD CL',
      escortComp: 'DD DD',
      radars: 2,
      drums: 1,
      radarShips: 2,
      speed: 10,
      hqMin: 105,
      hqMax: 115,
    })
    expect(routingFeatureLabel(result)).toBe(
      'DD CL / DD DD · 电探 2（2 舰）· 桶 1 · 高速 · 司令部 110±5',
    )
  })

  it('速力/司令部未知时特征为 0 且不进标签', () => {
    const result = getRoutingFleetFeatures(baseSnapshot)
    expect(result.speed).toBe(0)
    expect(result.hqMin).toBe(0)
    expect(result.hqMax).toBe(0)
    expect(routingFeatureLabel(result)).toBe('DD CL / DD DD · 电探 2（2 舰）· 桶 1')
  })

  it('司令部等级带宽收敛在 1~120 之间', () => {
    const low = getRoutingFleetFeatures({ ...baseSnapshot, hqLevel: 3 })
    expect(low.hqMin).toBe(1)
    expect(low.hqMax).toBe(8)
    const high = getRoutingFleetFeatures({ ...baseSnapshot, hqLevel: 119 })
    expect(high.hqMin).toBe(114)
    expect(high.hqMax).toBe(120)
  })
})
