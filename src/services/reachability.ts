import type {
  PoiEquipEntry,
  PoiFleetSnapshot,
  PoiShipEntry,
  RoutingFleetFeatures,
} from '../types'

const SHIP_CLASS = new Map<number, string>([
  [1, 'DE'],
  [2, 'DD'],
  [3, 'CL'],
  [4, 'CLT'],
  [5, 'CA'],
  [6, 'CAV'],
  [7, 'CVL'],
  [8, 'FBB'],
  [9, 'BB'],
  [10, 'BBV'],
  [11, 'CV'],
  [12, 'XBB'],
  [13, 'SS'],
  [14, 'SSV'],
  [15, 'AP'],
  [16, 'AV'],
  [17, 'LHA'],
  [18, 'CVB'],
  [19, 'AR'],
  [20, 'AS'],
  [21, 'CT'],
  [22, 'AO'],
])

const RADAR_IDS = new Set([
  27, 28, 29, 30, 31, 32, 88, 89, 106, 124, 141, 142, 240, 278, 279, 307,
  315,
])
const DRUM_ID = 75

const composition = (fleet: PoiShipEntry[] = []): string =>
  fleet
    .filter((entry): entry is NonNullable<PoiShipEntry> => entry != null)
    .map(([, master]) => SHIP_CLASS.get(Number(master.api_stype)) ?? 'XX')
    .join(' ')

const equipmentCount = (
  equips: PoiEquipEntry[][][],
  predicate: (id: number) => boolean,
): number => equips
  .flat(2)
  .filter((entry): entry is PoiEquipEntry => Array.isArray(entry) && entry[0] != null)
  .filter(([owned]) => predicate(owned.api_slotitem_id)).length

const radarShipCount = (equips: PoiEquipEntry[][][]): number => equips
  .flat(1)
  .filter((shipEquips) => shipEquips.some(
    (entry) => Array.isArray(entry) && entry[0] != null && RADAR_IDS.has(entry[0].api_slotitem_id),
  )).length

const HQ_BAND = 5
const HQ_MAX = 120

export const getRoutingFleetFeatures = (
  snapshot: PoiFleetSnapshot,
): RoutingFleetFeatures => {
  const hqLevel = Number(snapshot.hqLevel ?? 0)
  return {
    fleetType: snapshot.combinedFlag || 0,
    fleetNum: (snapshot.fleetIds[0] ?? 0) + 1,
    mainComp: composition(snapshot.fleets[0]),
    escortComp: snapshot.combinedFlag ? composition(snapshot.fleets[1]) : '',
    radars: equipmentCount(snapshot.equips, (id) => RADAR_IDS.has(id)),
    drums: equipmentCount(snapshot.equips, (id) => id === DRUM_ID),
    radarShips: radarShipCount(snapshot.equips),
    speed: Number(snapshot.speed ?? 0),
    hqMin: hqLevel > 0 ? Math.max(1, hqLevel - HQ_BAND) : 0,
    hqMax: hqLevel > 0 ? Math.min(HQ_MAX, hqLevel + HQ_BAND) : 0,
  }
}

const SPEED_LABEL = new Map<number, string>([
  [5, '低速'],
  [10, '高速'],
  [15, '高速+'],
  [20, '最速'],
])

export const routingFeatureLabel = (features: RoutingFleetFeatures): string => {
  const fleets = features.escortComp
    ? `${features.mainComp} / ${features.escortComp}`
    : features.mainComp
  const parts = [
    fleets || '未知编成',
    `电探 ${features.radars}（${features.radarShips} 舰）· 桶 ${features.drums}`,
  ]
  const speedLabel = SPEED_LABEL.get(features.speed)
  if (speedLabel) parts.push(speedLabel)
  if (features.hqMin > 0) {
    parts.push(`司令部 ${Math.round((features.hqMin + features.hqMax) / 2)}±${HQ_BAND}`)
  }
  return parts.join(' · ')
}
