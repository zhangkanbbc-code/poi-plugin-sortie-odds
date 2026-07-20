import { describe, expect, it } from 'vitest'

import { buildLbasInput, detectSupportMissions, resolveManualLbasStrikes } from '../src/services/lbas'

describe('detectSupportMissions', () => {
  it('识别道中(33)与决战(34)支援远征', () => {
    const fleets = [
      { api_mission: [0, 0, 0, 0] },
      { api_mission: [1, 33, 0, 0] },
      { api_mission: [1, 34, 0, 0] },
      { api_mission: [1, 5, 0, 0] },
    ]
    expect(detectSupportMissions(fleets)).toEqual({ normalFleetId: 1, bossFleetId: 2 })
  })

  it('没有支援时返回 null', () => {
    expect(detectSupportMissions([{ api_mission: [0, 0, 0, 0] }])).toEqual({
      normalFleetId: null,
      bossFleetId: null,
    })
    expect(detectSupportMissions(undefined)).toEqual({
      normalFleetId: null,
      bossFleetId: null,
    })
  })
})

describe('buildLbasInput', () => {
  const equipById = {
    '101': { api_slotitem_id: 550, api_level: 2, api_alv: 7 },
    '102': { api_slotitem_id: 551, api_level: 0, api_alv: 7 },
    '103': { api_slotitem_id: 552, api_level: 4, api_alv: 7 },
  }
  const airbases = [
    {
      api_area_id: 62,
      api_action_kind: 1,
      api_plane_info: [
        { api_slotid: 101, api_state: 1, api_count: 18, api_max_count: 18 },
        { api_slotid: 102, api_state: 1, api_count: 15, api_max_count: 18 },
      ],
    },
    {
      // 防空状态的基地不参与出击
      api_area_id: 62,
      api_action_kind: 2,
      api_plane_info: [
        { api_slotid: 103, api_state: 1, api_count: 18, api_max_count: 18 },
      ],
    },
    {
      // 其他海域的基地不参与
      api_area_id: 48,
      api_action_kind: 1,
      api_plane_info: [
        { api_slotid: 103, api_state: 1, api_count: 18, api_max_count: 18 },
      ],
    },
  ]

  it('只取当前海域、出击状态的基地，带改修/熟练与残余机数', () => {
    const result = buildLbasInput(airbases, equipById, 62)
    expect(result.bases).toHaveLength(1)
    expect(result.bases[0]).toEqual({
      equips: [
        { masterId: 550, improve: 2, proficiency: 7 },
        { masterId: 551, improve: 0, proficiency: 7 },
      ],
      slots: [18, 15],
    })
    // 每个出击基地两波
    expect(result.waves).toEqual([1, 1])
  })

  it('无可用基地时返回空', () => {
    expect(buildLbasInput(airbases, equipById, 55)).toEqual({ bases: [], waves: [] })
    expect(buildLbasInput(undefined, equipById, 62)).toEqual({ bases: [], waves: [] })
  })
})

describe('resolveManualLbasStrikes', () => {
  it('全部基地都没手动设置（全 0）时返回 null，交给默认集中打法', () => {
    expect(resolveManualLbasStrikes([[0, 0], [0, 0]], 99)).toBeNull()
    expect(resolveManualLbasStrikes([], 99)).toBeNull()
  })

  it('只要有一个基地手动设置，其余未设置的波次都解析为目标点边号', () => {
    expect(resolveManualLbasStrikes([[5, 0], [0, 0]], 99)).toEqual([[5, 99], [99, 99]])
  })

  it('手写的具体边号原样保留', () => {
    expect(resolveManualLbasStrikes([[12, 14], [12, 12]], 99)).toEqual([[12, 14], [12, 12]])
  })
})
