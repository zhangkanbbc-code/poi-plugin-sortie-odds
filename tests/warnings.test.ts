import { describe, expect, it } from 'vitest'

import { summarizeEngineWarnings } from '../src/services/warnings'
import type { EngineWarning } from '../src/types'

describe('summarizeEngineWarnings', () => {
  it('unknownstats 警告按舰船 ID 去重合并为一行中文', () => {
    const warnings: EngineWarning[] = [
      { key: 'warn_ship_unknownstats', txt: 'Warning: Real ship stats currently not known - 1776', args: [1776] },
      { key: 'warn_ship_unknownstats', txt: 'Warning: Real ship stats currently not known - 2310', args: [2310] },
      { key: 'warn_ship_unknownstats', txt: 'Warning: Real ship stats currently not known - 1776', args: [1776] },
      { key: 'warn_ship_unknownstats', txt: 'Warning: Real ship stats currently not known - 2310', args: [2310] },
    ]
    const lines = summarizeEngineWarnings(warnings)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1776')
    expect(lines[0]).toContain('2310')
    expect(lines[0]).toContain('推测值')
  })

  it('未知舰/装备警告分别合并', () => {
    const lines = summarizeEngineWarnings([
      { key: 'warn_unknown_ship', txt: 'Warning: Unknown ship - 2400', args: [2400] },
      { key: 'warn_unknown_equip', txt: 'Warning: Unknown equip - 1601', args: [1601] },
      { key: 'warn_unknown_equip', txt: 'Warning: Unknown equip - 1601', args: [1601] },
    ])
    expect(lines).toHaveLength(2)
    expect(lines.find((line) => line.includes('2400'))).toContain('图鉴数据缺失')
    expect(lines.find((line) => line.includes('1601'))).toContain('装备')
  })

  it('其他警告按原文去重并标注次数', () => {
    const lines = summarizeEngineWarnings([
      { key: 'warn_no_nb', txt: 'Warning: Night Battle not enabled on last node, intentional?' },
      { key: 'warn_no_nb', txt: 'Warning: Night Battle not enabled on last node, intentional?' },
      { key: 'other', txt: 'Something else' },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('Warning: Night Battle not enabled on last node, intentional? ×2')
    expect(lines[1]).toBe('Something else')
  })

  it('空输入返回空数组', () => {
    expect(summarizeEngineWarnings([])).toEqual([])
  })
})
