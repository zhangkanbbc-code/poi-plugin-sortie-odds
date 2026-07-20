export { SortieOdds as reactClass } from './src/views'
export { reducer } from './src/redux'
export { initHandler as pluginDidLoad, destroyHandler as pluginWillUnload } from './src/game-handler'

export const switchPluginPath = [
  '/kcsapi/api_req_map/start',
  '/kcsapi/api_req_map/next',
]
