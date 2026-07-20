import { describe, expect, it } from 'vitest'

import {
  buildSimulationInput,
  countSmokeGenerators,
  toEnemyComps,
  toPlayerFleet,
} from '../src/services/adapter'
import type { KcnavEnemyPayload, PoiFleetSnapshot, RouteEdge } from '../src/types'

const snapshot: PoiFleetSnapshot = {
  fleetIds: [0],
  combinedFlag: 0,
  fleets: [[[
    {
      api_ship_id: 1,
      api_lv: 80,
      api_nowhp: 12,
      api_maxhp: 30,
      api_cond: 49,
      api_fuel: 10,
      api_bull: 15,
      api_onslot: [0, 0],
      api_karyoku: [40, 50],
      api_raisou: [70, 80],
      api_taiku: [30, 40],
      api_soukou: [45, 50],
      api_kaihi: [60, 70],
      api_taisen: [50, 60],
      api_sakuteki: [20, 30],
      api_lucky: [12, 50],
    },
    { api_id: 1, api_leng: 1, api_soku: 10, api_fuel_max: 15, api_bull_max: 20 },
  ]]],
  equips: [[[[{ api_slotitem_id: 1, api_level: 4, api_alv: 0 }, { api_id: 1 }, 0]]]],
}

const enemy: KcnavEnemyPayload = {
  result: {
    entryCount: 1,
    entries: [{
      formation: 1,
      count: 25,
      mainFleet: [{
        id: 1501,
        name: '駆逐イ級',
        lvl: 1,
        hp: 20,
        fp: 5,
        torp: 15,
        aa: 6,
        armor: 5,
        equips: [501, -1],
      }],
    }],
  },
}

const edge: RouteEdge = { id: 2, from: 'A', to: 'B', nodeType: 5, eventKind: 5 }

describe('simulator adapter', () => {
  it('preserves current HP, fuel, ammo, morale and equipment', () => {
    const fleet = toPlayerFleet(snapshot)
    expect(fleet.ships[0]).toMatchObject({
      masterId: 1,
      HPInit: 12,
      fuelInit: 10 / 15,
      ammoInit: 15 / 20,
      morale: 49,
      equips: [{ masterId: 1, improve: 4, proficiency: 0 }],
    })
  })

  it('uses KCNav counts as comp weights and shifts abyssal equipment IDs', () => {
    expect(toEnemyComps(enemy)[0]).toMatchObject({
      weight: 25,
      fleet: { ships: [{ equips: [{ masterId: 1501 }] }] },
    })
  })

  it('默认总是在目标点进夜战（不设 doNBCond）', () => {
    const input = buildSimulationInput(snapshot, [{ edge, enemy }], 1000)
    expect(input.numSims).toBe(1000)
    expect(input.nodes[0].doNB).toBe(true)
    expect(input.nodes[0].doNBCond).toBeUndefined()
  })

  it('nightPolicy=ifBelowA 时保留旧行为', () => {
    const input = buildSimulationInput(snapshot, [{ edge, enemy }], 1000, {
      nightPolicy: 'ifBelowA',
    })
    expect(input.nodes[0]).toMatchObject({ doNB: true, doNBCond: 'A' })
  })

  it('有实际派遣记录时基航波次按玩家选择分配到节点', () => {
    const midEdge: RouteEdge = { id: 12, from: '1', to: 'A', nodeType: 4, eventKind: 4 }
    const bossEdge: RouteEdge = { id: 14, from: 'A', to: 'Z', nodeType: 5, eventKind: 5 }
    const input = buildSimulationInput(
      snapshot,
      [{ edge: midEdge, enemy }, { edge: bossEdge, enemy }],
      1000,
      {
        lbas: [{ equips: [{ masterId: 550 }], slots: [18, 18] }, { equips: [{ masterId: 551 }], slots: [18, 18] }],
        targetLbasWaves: [1, 1, 2, 2],
        // 一队两波都打 12（道中），二队一波 12 一波 14（boss）
        lbasStrikes: [[12, 12], [12, 14]],
      },
    )
    expect(input.nodes[0].lbas).toEqual([1, 1, 2])
    expect(input.nodes[1].lbas).toEqual([2])
  })

  it('支援舰队与基航波次接入目标点', () => {
    const midEdge: RouteEdge = { id: 1, from: '1', to: 'A', nodeType: 4, eventKind: 4 }
    const support = { formation: 1, ships: [] }
    const lbasBases = [{ equips: [{ masterId: 550 }], slots: [18, 18] }]
    const input = buildSimulationInput(
      snapshot,
      [{ edge: midEdge, enemy }, { edge, enemy }],
      1000,
      {
        supportNormal: support,
        supportBoss: support,
        lbas: lbasBases,
        targetLbasWaves: [1, 1],
      },
    )
    expect(input.fleetSupportN).toBe(support)
    expect(input.fleetSupportB).toBe(support)
    expect(input.lbas).toBe(lbasBases)
    expect(input.nodes[0].lbas).toEqual([])
    expect(input.nodes[1].lbas).toEqual([1, 1])
  })

  it('特效倍率与破甲倍率逐舰注入', () => {
    const input = buildSimulationInput(snapshot, [{ edge, enemy }], 1000, {
      bonusDmgAll: 1.2,
      debuffDmg: 1.15,
    })
    expect(input.fleetF.ships[0].bonuses).toEqual({ bonusDmg: 1.2 })
    expect(input.fleetF.ships[0].bonusesDebuff).toEqual({ bonusDmg: 1.15 })
  })

  it('倍率为 1 或未设置时不注入', () => {
    const input = buildSimulationInput(snapshot, [{ edge, enemy }], 1000, {
      bonusDmgAll: 1,
    })
    expect(input.fleetF.ships[0].bonuses).toBeUndefined()
    expect(input.fleetF.ships[0].bonusesDebuff).toBeUndefined()
  })

  it('smokeEdgeId 只在对应节点展开烟幕并注入补正常数', () => {
    const midEdge: RouteEdge = { id: 7, from: '1', to: 'A', nodeType: 4, eventKind: 4 }
    const input = buildSimulationInput(
      snapshot,
      [{ edge: midEdge, enemy }, { edge, enemy }],
      1000,
      { smokeEdgeId: 7 },
    )
    expect(input.nodes[0].useSmoke).toBe(true)
    expect(input.nodes[1].useSmoke).toBeUndefined()
    expect(input.consts).toMatchObject({ smokeChanceUseFormula: true })
    expect(input.consts.smokeModShellAccE).toEqual([0.1, 0.1, 0.1])
  })

  it('不用烟幕时 consts 保持为空', () => {
    const input = buildSimulationInput(snapshot, [{ edge, enemy }], 1000)
    expect(input.nodes[0].useSmoke).toBeUndefined()
    expect(input.consts).toEqual({})
  })

  it('countSmokeGenerators 统计发烟装置（改计 2）', () => {
    const withSmoke: typeof snapshot = {
      ...snapshot,
      equips: [[[
        [{ api_slotitem_id: 500, api_level: 4, api_alv: 0 }, { api_id: 500 }, 0],
        [{ api_slotitem_id: 501, api_level: 0, api_alv: 0 }, { api_id: 501 }, 0],
      ]]],
    }
    expect(countSmokeGenerators(withSmoke)).toBe(3)
    expect(countSmokeGenerators(snapshot)).toBe(0)
  })

  it('nightPolicy=never 时目标点不进夜战', () => {
    const input = buildSimulationInput(snapshot, [{ edge, enemy }], 1000, {
      nightPolicy: 'never',
    })
    expect(input.nodes[0].doNB).toBe(false)
  })

  it('targetFormation 只覆盖最后一个节点的阵形', () => {
    const midEdge: RouteEdge = { id: 1, from: '1', to: 'A', nodeType: 4, eventKind: 4 }
    const input = buildSimulationInput(
      snapshot,
      [{ edge: midEdge, enemy }, { edge, enemy }],
      1000,
      { targetFormation: 4 },
    )
    expect(input.nodes[0].formationOverride).toBe(1)
    expect(input.nodes[1].formationOverride).toBe(4)
  })

  it('不传 targetFormation 时沿用启发式阵形', () => {
    const input = buildSimulationInput(snapshot, [{ edge, enemy }], 1000)
    expect(input.nodes[0].formationOverride).toBe(1)
  })
})
