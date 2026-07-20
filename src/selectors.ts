import { getFleetSpeed, getSaku33 } from 'views/utils/game-utils'
import {
  fleetShipsDataSelectorFactory,
  fleetShipsEquipDataSelectorFactory,
} from 'views/utils/selectors'

import { toPlayerFleet } from './services/adapter'
import { detectSupportMissions } from './services/lbas'
import { effectiveCombinedFlag } from './services/live'
import type {
  PoiEquipEntry,
  PoiFleetSnapshot,
  PoiShipEntry,
  SimFleetInput,
} from './types'

const getFleetIds = (state: PoiRootState): number[] => {
  const sortieStatus = state.sortie?.sortieStatus ?? []
  const active = sortieStatus
    .map((isActive, index) => (isActive ? index : -1))
    .filter((index) => index >= 0)
  if (active.length > 0) return active
  if (state.sortie?.combinedFlag) return [0, 1]

  const thirdFleetShips = state.info?.fleets?.[2]?.api_ship ?? []
  if (thirdFleetShips.filter((id: number) => id > 0).length === 7) return [2]
  return [0]
}

const LOS_FACTORS = [1, 2, 3, 4]

export const selectCurrentFleet = (state: PoiRootState): PoiFleetSnapshot => {
  const fleetIds = getFleetIds(state)
  const fleets = fleetIds.map(
    (fleetId) => (fleetShipsDataSelectorFactory(fleetId)(state) ?? []) as PoiShipEntry[],
  )
  const equips = fleetIds.map(
    (fleetId) =>
      ((fleetShipsEquipDataSelectorFactory(fleetId)(state) ?? []) as PoiEquipEntry[][]),
  )
  const hqLevel = Number(state.info?.basic?.api_level ?? 0)

  // 与 poi 编成界面同源的数值：速力取全体最低，33式索敌按系数 1~4 各算一份；
  // 逐项防御，单项失败不阻断插件（数据未就绪等场合）
  let speed = 0
  try {
    const allShips = fleets.flat().filter((entry) => entry != null)
    const fleetSpeed = getFleetSpeed(allShips).speed
    speed = Number.isFinite(fleetSpeed) ? Number(fleetSpeed) : 0
  } catch {
    // 保持 0（未知）
  }
  const los = LOS_FACTORS.map((factor) => {
    try {
      const value = getSaku33(
        fleets[0] ?? [],
        equips[0] ?? [],
        hqLevel,
        factor,
        (fleets[0] ?? []).length || 6,
      )
      return Number.isFinite(value) ? Math.round(value * 10) / 10 : Number.NaN
    } catch {
      return Number.NaN
    }
  })

  return {
    fleetIds,
    fleets,
    equips,
    combinedFlag: effectiveCombinedFlag(
      fleetIds,
      Number(state.sortie?.combinedFlag ?? 0),
    ),
    speed,
    hqLevel,
    los,
  }
}

export interface SupportFleets {
  normal: SimFleetInput | null
  boss: SimFleetInput | null
}

// 检测已出港的道中(33)/决战(34)支援远征并构建模拟输入
export const selectSupportFleets = (state: PoiRootState): SupportFleets => {
  const { normalFleetId, bossFleetId } = detectSupportMissions(state.info?.fleets)
  const build = (fleetId: number | null): SimFleetInput | null => {
    if (fleetId == null) return null
    const ships = (fleetShipsDataSelectorFactory(fleetId)(state) ?? []) as PoiShipEntry[]
    const equips =
      ((fleetShipsEquipDataSelectorFactory(fleetId)(state) ?? []) as PoiEquipEntry[][])
    const fleet = toPlayerFleet({
      fleetIds: [fleetId],
      fleets: [ships],
      equips: [equips],
      combinedFlag: 0,
    })
    return fleet.ships.length > 0 ? fleet : null
  }
  return { normal: build(normalFleetId), boss: build(bossFleetId) }
}
