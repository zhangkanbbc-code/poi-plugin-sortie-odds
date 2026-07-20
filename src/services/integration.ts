import { safeCount } from './live'
import { getEdgeMap } from './route'
import type {
  AkashicSettlement,
  KcnavMapPayload,
  PluginIntegrationState,
  PoiFleetSnapshot,
  PoiShipEntry,
  ProphetBattleSnapshot,
  ProphetShipSnapshot,
} from '../types'

interface RawAkashicState {
  attack?: { data?: unknown[][] }
}

interface RawProphetState {
  battle?: ProphetBattleSnapshot
}

const parseAkashicSettlement = (row: unknown[] | undefined): AkashicSettlement | null => {
  if (!row || row.length < 5) return null
  const timestamp = Number(row[0])
  const mapText = String(row[1] ?? '')
  const nodeText = String(row[2] ?? '')
  const resultText = String(row[4] ?? '')
  const mapId = mapText.match(/\((\d+-\d+)/)?.[1] ?? null
  const node = nodeText.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const rank = resultText.match(/([SABCDE])\s*$/)?.[1] ?? null
  if (!Number.isFinite(timestamp) || !node) return null
  return { timestamp, mapId, node, rank }
}

export const readPluginIntegrations = (state: PoiRootState): PluginIntegrationState => {
  const ext = state.ext ?? {}
  const prophetRaw = ext['poi-plugin-prophet'] as RawProphetState | undefined
  const akashicRaw = ext['poi-plugin-akashic-records'] as RawAkashicState | undefined
  return {
    prophetAvailable: prophetRaw != null,
    akashicAvailable: akashicRaw != null,
    prophetBattle: prophetRaw?.battle ?? null,
    latestAkashic: parseAkashicSettlement(akashicRaw?.attack?.data?.[0]),
    prophetAppliedShips: 0,
  }
}

export const prophetBattleFingerprint = (
  battle: ProphetBattleSnapshot | null,
): string => {
  if (!battle) return 'unavailable'
  const fleet = [...(battle.mainFleet ?? []), ...(battle.escortFleet ?? [])]
    .map((ship) => `${ship?.raw?.api_id ?? ship?.pos ?? '-'}:${ship?.nowHP ?? '-'}`)
    .join(',')
  return `${battle.sortieState ?? '-'}|${battle.result?.rank ?? '-'}|${fleet}`
}

const prophetShipId = (ship: ProphetShipSnapshot | null | undefined): number | null => {
  const id = Number(ship?.raw?.api_id)
  return Number.isFinite(id) && id > 0 ? id : null
}

const patchFleet = (
  fleet: PoiShipEntry[],
  prophetFleet: Array<ProphetShipSnapshot | null> = [],
): { fleet: PoiShipEntry[]; applied: number } => {
  const byId = new Map<number, ProphetShipSnapshot>()
  prophetFleet.forEach((ship) => {
    const id = prophetShipId(ship)
    if (id != null && ship) byId.set(id, ship)
  })
  let applied = 0
  return {
    fleet: fleet.map((entry, index) => {
      if (!entry) return entry
      const [raw, master] = entry
      const source = (raw.api_id ? byId.get(raw.api_id) : undefined) ?? prophetFleet[index]
      const nowHP = Number(source?.nowHP)
      if (!Number.isFinite(nowHP) || nowHP < 0) return entry
      applied += 1
      return [{ ...raw, api_nowhp: nowHP }, master]
    }),
    applied,
  }
}

export const applyProphetSettlement = (
  snapshot: PoiFleetSnapshot,
  battle: ProphetBattleSnapshot | null,
  expectedRank: string | null,
): { snapshot: PoiFleetSnapshot; appliedShips: number } => {
  if (!battle || !expectedRank || battle.result?.rank !== expectedRank) {
    return { snapshot, appliedShips: 0 }
  }
  const main = patchFleet(snapshot.fleets[0] ?? [], battle.mainFleet)
  const escort = patchFleet(snapshot.fleets[1] ?? [], battle.escortFleet)
  return {
    snapshot: {
      ...snapshot,
      fleets: snapshot.fleets.map((fleet, index) =>
        index === 0 ? main.fleet : index === 1 ? escort.fleet : fleet,
      ),
    },
    appliedShips: main.applied + escort.applied,
  }
}

export const completedEdgeCountFromLogs = (
  map: KcnavMapPayload,
  actualEdges: number[],
  mapId: string,
  ownCompletedCount: number,
  settlement: AkashicSettlement | null,
  notBefore = 0,
): number => {
  // 上钳：结算数不可能超过已走边数；下界：能走到第 N 点说明前 N-1 点已结算。
  // 下界在视图边界再兜一次底，任何来源的结算缺漏都不会把已打完的节点算回剩余模拟。
  // safeCount 兜 NaN/非数值（同一条 NaN 防线，见 live.ts 的说明，不在此重写一份）
  let completed = Math.max(
    Math.min(safeCount(ownCompletedCount), actualEdges.length),
    actualEdges.length - 1,
  )
  if (!settlement || settlement.mapId !== mapId || settlement.timestamp < notBefore) return completed
  const edgeMap = getEdgeMap(map)
  for (let index = actualEdges.length - 1; index >= 0; index -= 1) {
    if (edgeMap.get(actualEdges[index])?.to === settlement.node) {
      completed = Math.max(completed, index + 1)
      break
    }
  }
  return completed
}
