export const PLUGIN_KEY = 'poi-plugin-sortie-odds'
export const KCNAV_BASE_URL = 'https://tsunkit.net/api/routing'
export const ENGINE_MESSAGE_SOURCE = 'poi-sortie-odds-engine'

export const NODE_TYPE = {
  Start: 0,
  Resource: 2,
  Maelstrom: 3,
  Battle: 4,
  Boss: 5,
  Transport: 6,
  AirBattle: 7,
  Finish: 8,
  AirResource: 9,
  AirRaid: 10,
  NightBattle: 11,
  Ambush: 13,
  Repair: 14,
  SubStrike: 15,
  Nothing: 90,
  Choice: 91,
  Unknown: -1,
  LandBase: -2,
} as const

export const PLUGIN_UA = 'poi-plugin-sortie-odds/0.9.2'

export const PROPHET_PLUGIN_ID = 'poi-plugin-prophet'
export const CONFIG_SWITCH_TO_PROPHET = `plugin.${PLUGIN_KEY}.switchToProphet`

export const ENEMY_NODE_TYPES = new Set<number>([
  NODE_TYPE.Battle,
  NODE_TYPE.Boss,
  NODE_TYPE.AirBattle,
  NODE_TYPE.AirRaid,
  NODE_TYPE.NightBattle,
  NODE_TYPE.Ambush,
  NODE_TYPE.SubStrike,
  NODE_TYPE.Unknown,
])
