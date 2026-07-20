export type KcnavRouteTuple = [string | null, string, number, number]

export interface KcnavMapPayload {
  result: {
    route: Record<string, KcnavRouteTuple>
    spots?: Record<string, [number, number, string | null]>
  }
  retrieved?: string
}

export interface RouteEdge {
  id: number
  from: string | null
  to: string
  nodeType: number
  eventKind: number
}

export interface KcnavEnemyShip {
  id: number
  name?: string
  name_en?: string
  lvl: number
  hp: number
  fp: number
  torp: number
  aa: number
  armor: number
  equips: number[]
  exslot?: number
}

export interface KcnavEnemyEntry {
  map?: string
  node?: string
  mainFleet?: KcnavEnemyShip[]
  fleet?: KcnavEnemyShip[]
  escortFleet?: KcnavEnemyShip[]
  formation: number
  count: number
}

export interface KcnavEnemyPayload {
  result: {
    entryCount: number
    entries: KcnavEnemyEntry[]
  }
  retrieved?: string
}

export interface KcnavGimmicksPayload {
  result?: {
    map?: string
    // difficulties[难度].phases[期数].nodes = { 节点: 需求评价 }
    difficulties?: Record<string, {
      phases?: Record<string, { nodes?: Record<string, string> }>
    }>
  }
  retrieved?: string
}

export interface KcnavRouteEntryPayload {
  result?: {
    entries?: unknown[]
    pageCount?: number
  }
  retrieved?: string
}

export interface PoiShipRaw {
  api_id?: number
  api_ship_id: number
  api_lv: number
  api_nowhp: number
  api_maxhp: number
  api_cond?: number
  api_fuel?: number
  api_bull?: number
  api_onslot?: number[]
  api_karyoku?: number[]
  api_raisou?: number[]
  api_taiku?: number[]
  api_soukou?: number[]
  api_kaihi?: number[]
  api_taisen?: number[]
  api_sakuteki?: number[]
  api_lucky?: number[]
}

export interface PoiShipMaster {
  api_id: number
  api_name?: string
  api_stype?: number
  api_soku?: number
  api_leng?: number
  api_fuel_max?: number
  api_bull_max?: number
}

export interface PoiEquipRaw {
  api_slotitem_id: number
  api_level?: number
  api_alv?: number
}

export interface PoiEquipMaster {
  api_id: number
  api_name?: string
}

export type PoiShipEntry = [PoiShipRaw, PoiShipMaster] | undefined
export type PoiEquipEntry = [PoiEquipRaw, PoiEquipMaster, number | undefined]

export interface PoiFleetSnapshot {
  fleetIds: number[]
  fleets: PoiShipEntry[][]
  equips: PoiEquipEntry[][][]
  combinedFlag: number
  // poi 本体 game-utils 算出的编成界面同款数值（选择器填充；测试夹具可省略）
  speed?: number
  hqLevel?: number
  los?: number[]
}

export interface RoutingFleetFeatures {
  fleetType: number
  fleetNum: number
  mainComp: string
  escortComp: string
  radars: number
  drums: number
  radarShips: number
  speed: number
  hqMin: number
  hqMax: number
}

export type RouteEvidenceState = 'idle' | 'checking' | 'supported' | 'unknown' | 'unavailable'

export interface RouteEvidence {
  state: RouteEvidenceState
  matchedEntries: number
  pageCount?: number
  detail?: string
}

export interface SimEquipInput {
  masterId: number
  improve?: number
  proficiency?: number
}

export interface SimShipInput {
  masterId: number
  LVL: number
  stats?: Record<string, number | number[] | null>
  HPInit?: number
  fuelInit?: number
  ammoInit?: number
  morale?: number
  equips: SimEquipInput[]
  includesEquipStats?: boolean
  // 活动特效倍率（全程生效）与破甲倍率（仅 boss 点对 boss 旗舰生效）
  bonuses?: { bonusDmg?: number; bonusAcc?: number; bonusEva?: number }
  bonusesDebuff?: { bonusDmg?: number }
}

export interface SimFleetInput {
  formation: number
  combineType?: number
  ships: SimShipInput[]
  shipsC?: SimShipInput[]
}

export interface SimFleetCompInput {
  fleet: SimFleetInput
  weight: number
}

export interface SimNodeInput {
  fleetEComps: SimFleetCompInput[]
  formationOverride: number
  doNB: boolean
  doNBCond?: 'A' | 'B' | 'flagsunk'
  NBOnly: boolean
  airOnly: boolean
  airRaid: boolean
  noAmmo: boolean
  lbas: number[]
  useNormalSupport?: boolean
  useSmoke?: boolean
}

export interface LbasBaseInput {
  equips: SimEquipInput[]
  slots: number[]
}

export interface SimulationInput {
  numSims: number
  fleetF: SimFleetInput
  fleetSupportN: SimFleetInput | null
  fleetSupportB: SimFleetInput | null
  lbas: LbasBaseInput[] | null
  fleetFriendComps: null
  // 手动预设的友军舰队（单一固定编成，非概率分布）；用户在活动图里照社区
  // 情报手填舰种+等级，无装备加成（v1 简化，见 adapter.ts buildFriendFleet）
  fleetFriend?: SimFleetInput | null
  nodes: SimNodeInput[]
  continueOnTaiha: boolean
  retreatOnChuuhaIfAll: number
  allowAnyFormation: boolean
  carryOverHP: boolean
  carryOverMorale: boolean
  tpFormula: string
  mechanics: Record<string, unknown>
  consts: Record<string, unknown>
  includeTimeStats: false
}

export interface SimulationNodeResult {
  num: number
  ranks: Record<'S' | 'A' | 'B' | 'C' | 'D' | 'E', number>
  flagsunk: number
  taiha: number
  taihaIndiv: number[]
  taihaIndivC: number[]
  airStates: number[]
}

export interface SimulationResult {
  totalnum: number
  nodes: SimulationNodeResult[]
  // 战力条：boss 旗舰累计削血
  totalGaugeDamage: number
  // 输送条：按 S 全额 / A ×0.7 取整 / B 以下 0 累计的 TP（含沉没退避扣减）
  totalTransport: number
}

export interface ShipCapability {
  oasw: boolean
  aaciTypes: number[]
  dayCutin: boolean
  specialAttack: boolean
}

export interface FleetInspectResult {
  main: ShipCapability[]
  escort: ShipCapability[]
  specialFormations: number[]
  // 本队 TP 容量（S 胜带出量；A 胜 = floor(×0.7)）
  transportS: number
}

// 友军舰队手动预设的舰船名录条目（来自隐藏 iframe 的 SHIPDATA，见 simulator.ts listShips）
export interface ShipListEntry {
  id: number
  name: string
  nameJP: string
}

// 用户手填的友军单舰：舰种+等级，无装备（v1 简化）
export interface FriendShipSlot {
  masterId: number
  level: number
}

export interface EngineWarning {
  key?: string
  txt?: string
  args?: unknown[]
}

export interface EngineRunResult {
  result: SimulationResult
  warnings: EngineWarning[]
}

export interface LiveSortieState {
  active: boolean
  mapId: string | null
  actualEdges: number[]
  startedAt: number
  completedEdgeCount: number
  lastRank: string | null
  settlementAt: number
  updatedAt: number
  // 本次出击基航实际派遣：每基地两波的目标格子号（api_strike_point_N）
  lbasStrikes: number[][] | null
  // 当前节点战斗进行中（战斗包已到、battleresult 未到）。
  // 不能用 prophet 的 sortieState 判断——它整个出击期间常驻 2，
  // 会把"刚到新节点未开战"误判为战斗中，堵死到点重算的窗口
  battleOngoing: boolean
}

export interface ProphetShipSnapshot {
  nowHP?: number
  maxHP?: number
  pos?: number
  raw?: { api_id?: number; api_ship_id?: number }
}

export interface ProphetBattleSnapshot {
  mainFleet?: Array<ProphetShipSnapshot | null>
  escortFleet?: Array<ProphetShipSnapshot | null>
  sortieState?: number
  result?: { rank?: string }
}

export interface AkashicSettlement {
  timestamp: number
  mapId: string | null
  node: string
  rank: string | null
}

export interface PluginIntegrationState {
  prophetAvailable: boolean
  akashicAvailable: boolean
  prophetBattle: ProphetBattleSnapshot | null
  latestAkashic: AkashicSettlement | null
  prophetAppliedShips: number
}
