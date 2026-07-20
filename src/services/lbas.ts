import type { LbasBaseInput, SimEquipInput } from '../types'

interface PoiAirbasePlane {
  api_slotid?: number
  api_state?: number
  api_count?: number
}

interface PoiAirbase {
  api_area_id?: number
  api_action_kind?: number
  api_plane_info?: PoiAirbasePlane[]
}

interface PoiSlotitem {
  api_slotitem_id?: number
  api_level?: number
  api_alv?: number
}

// 33=前卫（道中）支援，34=舰队决战支援；status>0 表示已出港
export const detectSupportMissions = (
  fleets: Array<{ api_mission?: number[] }> | undefined,
): { normalFleetId: number | null; bossFleetId: number | null } => {
  let normalFleetId: number | null = null
  let bossFleetId: number | null = null
  ;(fleets ?? []).forEach((fleet, index) => {
    const [status, missionId] = fleet.api_mission ?? []
    if (!status || status <= 0) return
    if (missionId === 33) normalFleetId = index
    if (missionId === 34) bossFleetId = index
  })
  return { normalFleetId, bossFleetId }
}

// 只取当前海域、出击状态(action_kind=1)的基地；机数用实时残余值。
// 返回的 waves 是"每个基地两波、全部集中一个节点"的默认分配（1-based 基地号）
export const buildLbasInput = (
  airbases: PoiAirbase[] | undefined,
  equipById: Record<string, PoiSlotitem | undefined>,
  world: number,
): { bases: LbasBaseInput[]; waves: number[] } => {
  const bases: LbasBaseInput[] = []
  for (const base of airbases ?? []) {
    if (Number(base.api_area_id) !== world || Number(base.api_action_kind) !== 1) continue
    const equips: SimEquipInput[] = []
    const slots: number[] = []
    for (const plane of base.api_plane_info ?? []) {
      if (Number(plane.api_state) !== 1) continue
      const item = equipById[String(plane.api_slotid)]
      if (!item?.api_slotitem_id) continue
      equips.push({
        masterId: item.api_slotitem_id,
        improve: Number(item.api_level ?? 0),
        proficiency: Number(item.api_alv ?? 0),
      })
      slots.push(Number(plane.api_count ?? 0))
    }
    if (equips.length > 0) bases.push({ equips, slots })
  }
  const waves: number[] = []
  bases.forEach((_, index) => {
    waves.push(index + 1, index + 1)
  })
  return { bases, waves }
}

// 计划模式（无实际派遣数据）下，把玩家按基地手写的两波目标解析成
// buildSimulationInput 的 lbasStrikes 形状：外层按基地序号，内层为该基地
// 命中的节点 edge id 列表。手写值 0 = 跟随目标点（默认全集中打法）。
// 全部基地都没手动设置时返回 null，交给上层的 targetLbasWaves 兜底
export const resolveManualLbasStrikes = (
  waves: number[][],
  targetEdgeId: number,
): number[][] | null => {
  if (!waves.some((row) => row.some((cell) => cell > 0))) return null
  return waves.map((row) =>
    row.map((cell) => (cell > 0 ? cell : targetEdgeId)).filter((cell) => cell > 0))
}
