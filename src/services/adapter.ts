import { NODE_TYPE } from '../constants'
import type {
  FriendShipSlot,
  KcnavEnemyEntry,
  KcnavEnemyPayload,
  KcnavEnemyShip,
  LbasBaseInput,
  PoiEquipEntry,
  PoiFleetSnapshot,
  PoiShipEntry,
  RouteEdge,
  SimFleetCompInput,
  SimFleetInput,
  SimNodeInput,
  SimShipInput,
  SimulationInput,
} from '../types'

const firstNumber = (value: number[] | undefined, fallback = 0): number =>
  Number(value?.[0] ?? fallback)

const clampRatio = (value: number | undefined, max: number | undefined): number => {
  if (!value || !max) return 1
  return Math.max(0, Math.min(1, value / max))
}

const toPlayerShip = (
  entry: PoiShipEntry,
  equips: PoiEquipEntry[] = [],
): SimShipInput | null => {
  if (!entry) return null
  const [ship, master] = entry
  const slotCounts = ship.api_onslot ?? []
  const equipped = equips.reduce<Array<{ equip: PoiEquipEntry; index: number }>>(
    (result, equip, index) => {
      if (Array.isArray(equip) && equip[0] != null) result.push({ equip, index })
      return result
    },
    [],
  )
  return {
    masterId: ship.api_ship_id,
    LVL: ship.api_lv,
    stats: {
      HP: ship.api_maxhp,
      FP: firstNumber(ship.api_karyoku),
      TP: firstNumber(ship.api_raisou),
      AA: firstNumber(ship.api_taiku),
      AR: firstNumber(ship.api_soukou),
      EV: firstNumber(ship.api_kaihi),
      ASW: firstNumber(ship.api_taisen),
      LOS: firstNumber(ship.api_sakuteki),
      LUK: firstNumber(ship.api_lucky),
      RNG: Number(master.api_leng ?? 0),
      SPD: Number(master.api_soku ?? 0),
      SLOTS: equipped.map(({ index }) => Number(slotCounts[index] ?? 0)),
      TACC: null,
    },
    HPInit: ship.api_nowhp,
    fuelInit: clampRatio(ship.api_fuel, master.api_fuel_max),
    ammoInit: clampRatio(ship.api_bull, master.api_bull_max),
    morale: Number(ship.api_cond ?? 49),
    equips: equipped.map(({ equip: [owned] }) => ({
      masterId: owned.api_slotitem_id,
      improve: Number(owned.api_level ?? 0),
      proficiency: Number(owned.api_alv ?? 0),
    })),
    includesEquipStats: false,
  }
}

const mapFleet = (ships: PoiShipEntry[], equips: PoiEquipEntry[][]): SimShipInput[] =>
  ships
    .map((ship, index) => toPlayerShip(ship, equips[index]))
    .filter((ship): ship is SimShipInput => ship != null)

export const toPlayerFleet = (snapshot: PoiFleetSnapshot): SimFleetInput => {
  const ships = mapFleet(snapshot.fleets[0] ?? [], snapshot.equips[0] ?? [])
  const combineType = snapshot.combinedFlag && snapshot.fleets.length > 1
    ? snapshot.combinedFlag
    : 0
  const fleet: SimFleetInput = {
    formation: combineType ? 14 : 1,
    ships,
  }
  if (combineType) {
    fleet.combineType = combineType
    fleet.shipsC = mapFleet(snapshot.fleets[1] ?? [], snapshot.equips[1] ?? [])
  }
  return fleet
}

// 友军舰队手动预设：只给 masterId+LVL，不给 stats——模拟器自带按 SHIPDATA
// 查表+等级插值的兜底路径（sim-interface.js 的 shipInput.stats 分支），
// 省去在插件里重实现舰娘属性成长公式。v1 不做装备加成，纯基础舰船数值
export const buildFriendFleet = (slots: FriendShipSlot[]): SimFleetInput | null => {
  const ships: SimShipInput[] = slots
    .filter((slot) => slot.masterId > 0)
    .map((slot) => ({
      masterId: slot.masterId,
      LVL: Math.max(1, Math.round(slot.level) || 99),
      equips: [],
    }))
  return ships.length > 0 ? { formation: 1, ships } : null
}

const shiftedEnemyEquipId = (id: number): number =>
  id > 500 && id < 1000 ? id + 1000 : id

const toEnemyShip = (ship: KcnavEnemyShip): SimShipInput => ({
  masterId: ship.id,
  LVL: ship.lvl,
  stats: {
    HP: ship.hp,
    FP: ship.fp,
    TP: ship.torp,
    AA: ship.aa,
    AR: ship.armor,
  },
  HPInit: ship.hp,
  equips: [
    ...ship.equips.filter((id) => id > 0),
    ...(ship.exslot && ship.exslot > 0 ? [ship.exslot] : []),
  ].map((id) => ({ masterId: shiftedEnemyEquipId(id), proficiency: 0 })),
  includesEquipStats: false,
})

const toEnemyComp = (entry: KcnavEnemyEntry): SimFleetCompInput => {
  const main = entry.mainFleet ?? entry.fleet ?? []
  const fleet: SimFleetInput = {
    formation: Number(entry.formation || 1),
    ships: main.map(toEnemyShip),
  }
  if (entry.escortFleet?.length) {
    fleet.combineType = 1
    fleet.shipsC = entry.escortFleet.map(toEnemyShip)
  }
  return { fleet, weight: Math.max(1, Number(entry.count || 1)) }
}

export const toEnemyComps = (payload: KcnavEnemyPayload): SimFleetCompInput[] =>
  payload.result.entries.map(toEnemyComp).filter((comp) => comp.fleet.ships.length > 0)

const isSubmarineName = (ship: KcnavEnemyShip): boolean =>
  /潜水|submarine/i.test(`${ship.name ?? ''} ${ship.name_en ?? ''}`)

const isAllSubmarine = (payload: KcnavEnemyPayload): boolean =>
  payload.result.entries.length > 0 && payload.result.entries.every((entry) => {
    const ships = [...(entry.mainFleet ?? entry.fleet ?? []), ...(entry.escortFleet ?? [])]
    return ships.length > 0 && ships.every(isSubmarineName)
  })

const playerFormation = (
  edge: RouteEdge,
  enemy: KcnavEnemyPayload,
  combined: boolean,
): number => {
  if (edge.nodeType === NODE_TYPE.NightBattle) return 1
  if (edge.nodeType === NODE_TYPE.AirRaid) return combined ? 13 : 3
  if (isAllSubmarine(enemy)) return combined ? 11 : 5
  return combined ? 14 : 1
}

export interface BattleSource {
  edge: RouteEdge
  enemy: KcnavEnemyPayload
}

export type NightPolicy = 'always' | 'ifBelowA' | 'never'

export interface SimulationBuildOptions {
  // 覆盖目标点（最后一个节点）的我方阵形；特攻编成需要特定阵形才能触发
  targetFormation?: number
  // 覆盖道中（非目标）战斗节点的我方阵形（输送队道中警戒阵等打法）；
  // 空袭点保持启发式（轮形/第三警戒）
  midFormation?: number
  // 目标点夜战策略：默认总是进夜战（求 S 的真实打法）；
  // ifBelowA=昼战未达 A 才进（刷图省资源）；never=不进
  nightPolicy?: NightPolicy
  // 道中支援（模拟器自动只在非目标节点生效）
  supportNormal?: SimFleetInput | null
  // 决战支援（模拟器自动只在目标节点生效）
  supportBoss?: SimFleetInput | null
  // 基地航空队与集中到目标点的波次（1-based 基地号，每基地两波）
  lbas?: LbasBaseInput[] | null
  targetLbasWaves?: number[]
  // 玩家本次出击的实际派遣（各基地波次的目标格子号）；提供时优先于 targetLbasWaves
  lbasStrikes?: number[][] | null
  // 在此边展开烟幕（一次出击只能放一次，由模拟器内部保证）
  smokeEdgeId?: number
  // 活动特效倍率（全队默认值）；1 或省略 = 无
  bonusDmgAll?: number
  // 逐舰特效倍率（masterId → 倍率），覆盖全队默认值
  bonusPerShip?: Record<number, number>
  // 破甲倍率（仅 boss 点对 boss 旗舰生效，模拟器自动锁定目标）；1 或省略 = 无
  debuffDmg?: number
  // 友军舰队手动预设（用户按社区情报手填舰种+等级，见 buildFriendFleet）
  friendFleet?: SimFleetInput | null
}

const SMOKE_GENERATOR = 500
const SMOKE_GENERATOR_KAI = 501

// 烟幕命中补正（社区检证值，tata @about6833 2023-2024）：
// 敌炮击无电探 ×0.1、有电探 ×0.4（0.35~0.45 取中）、对潜 ×0.25、
// 雷击 1本0.7/3本0.5（2本为插值）、航空 ×0.5（弱证据）；我方按同机制对称取值
const SMOKE_CONSTS = {
  smokeChanceUseFormula: true,
  smokeModShellAccF: [0.1, 0.1, 0.1],
  smokeModShellAccFRadar: [0.4, 0.4, 0.4],
  smokeModShellAccE: [0.1, 0.1, 0.1],
  smokeModShellAccERadar: [0.4, 0.4, 0.4],
  smokeModASWAccF: [0.25, 0.25, 0.25],
  smokeModASWAccE: [0.25, 0.25, 0.25],
  smokeModTorpAccF: [0.7, 0.6, 0.5],
  smokeModTorpAccE: [0.7, 0.6, 0.5],
  smokeModAirAccF: [0.5, 0.5, 0.5],
  smokeModAirAccE: [0.5, 0.5, 0.5],
}

export const countSmokeGenerators = (snapshot: PoiFleetSnapshot): number =>
  snapshot.equips
    .flat(2)
    .filter((entry): entry is NonNullable<typeof entry> =>
      Array.isArray(entry) && entry[0] != null)
    .reduce((count, [owned]) => {
      if (owned.api_slotitem_id === SMOKE_GENERATOR) return count + 1
      if (owned.api_slotitem_id === SMOKE_GENERATOR_KAI) return count + 2
      return count
    }, 0)

export const buildSimulationInput = (
  snapshot: PoiFleetSnapshot,
  battles: BattleSource[],
  numSims: number,
  options: SimulationBuildOptions = {},
): SimulationInput => {
  const fleetF = toPlayerFleet(snapshot)
  const combined = !!fleetF.shipsC?.length

  const bonusDmgAll = Number(options.bonusDmgAll ?? 1)
  const bonusPerShip = options.bonusPerShip ?? {}
  const debuffDmg = Number(options.debuffDmg ?? 1)
  if (bonusDmgAll !== 1 || debuffDmg !== 1 || Object.keys(bonusPerShip).length > 0) {
    const applyBonuses = (ship: SimShipInput): SimShipInput => {
      const bonusDmg = Number(bonusPerShip[ship.masterId] ?? bonusDmgAll)
      return {
        ...ship,
        ...(bonusDmg !== 1 ? { bonuses: { bonusDmg } } : {}),
        ...(debuffDmg !== 1 ? { bonusesDebuff: { bonusDmg: debuffDmg } } : {}),
      }
    }
    fleetF.ships = fleetF.ships.map(applyBonuses)
    if (fleetF.shipsC) fleetF.shipsC = fleetF.shipsC.map(applyBonuses)
  }
  const nodes: SimNodeInput[] = battles.map(({ edge, enemy }, index) => {
    const isTarget = index === battles.length - 1
    const canNight = ![
      NODE_TYPE.AirBattle,
      NODE_TYPE.AirRaid,
      NODE_TYPE.SubStrike,
    ].includes(edge.nodeType as 7 | 10 | 15)
    const nightPolicy = options.nightPolicy ?? 'always'
    const nightCapable = isTarget && canNight && edge.nodeType !== NODE_TYPE.NightBattle
    return {
      fleetEComps: toEnemyComps(enemy),
      formationOverride: isTarget && options.targetFormation
        ? options.targetFormation
        : (!isTarget && options.midFormation && edge.nodeType !== NODE_TYPE.AirRaid
          ? options.midFormation
          : playerFormation(edge, enemy, combined)),
      doNB: nightCapable && nightPolicy !== 'never',
      ...(nightCapable && nightPolicy === 'ifBelowA'
        ? { doNBCond: 'A' as const }
        : {}),
      NBOnly: edge.nodeType === NODE_TYPE.NightBattle,
      airOnly: edge.nodeType === NODE_TYPE.AirBattle || edge.nodeType === NODE_TYPE.SubStrike,
      airRaid: edge.nodeType === NODE_TYPE.AirRaid,
      noAmmo: isAllSubmarine(enemy),
      lbas: options.lbasStrikes?.length
        ? options.lbasStrikes.flatMap((strikes, baseIndex) =>
          strikes.filter((cell) => cell === edge.id).map(() => baseIndex + 1))
        : (isTarget ? (options.targetLbasWaves ?? []) : []),
      ...(options.smokeEdgeId != null && options.smokeEdgeId === edge.id
        ? { useSmoke: true }
        : {}),
    }
  })

  return {
    numSims,
    fleetF,
    fleetSupportN: options.supportNormal ?? null,
    fleetSupportB: options.supportBoss ?? null,
    lbas: options.lbas ?? null,
    fleetFriendComps: null,
    fleetFriend: options.friendFleet ?? null,
    nodes,
    continueOnTaiha: false,
    retreatOnChuuhaIfAll: 0,
    allowAnyFormation: false,
    carryOverHP: false,
    carryOverMorale: false,
    tpFormula: 'def',
    mechanics: {},
    consts: options.smokeEdgeId != null ? { ...SMOKE_CONSTS } : {},
    includeTimeStats: false,
  }
}
