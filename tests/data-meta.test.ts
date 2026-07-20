import { describe, expect, it } from 'vitest'

import {
  formatDataAge,
  sourceLabel,
  summarizeResources,
} from '../src/services/data-meta'

const NOW = Date.parse('2026-07-16T12:00:00Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('data-meta', () => {
  it('formatDataAge 分档', () => {
    expect(formatDataAge(NOW - 10 * 1000, NOW)).toBe('刚刚')
    expect(formatDataAge(NOW - 5 * MINUTE, NOW)).toBe('5 分钟前')
    expect(formatDataAge(NOW - 3 * HOUR, NOW)).toBe('3 小时前')
    expect(formatDataAge(NOW - 2 * DAY, NOW)).toBe('2 天前')
  })

  it('summarizeResources 取最差来源，同级取最旧', () => {
    expect(summarizeResources([])).toBeNull()
    expect(
      summarizeResources([
        { source: 'disk', savedAt: NOW - DAY },
        { source: 'disk-stale', savedAt: NOW - HOUR },
        { source: 'network', savedAt: NOW },
      ]),
    ).toMatchObject({ source: 'disk-stale' })
    expect(
      summarizeResources([
        { source: 'disk', savedAt: NOW - 2 * DAY },
        { source: 'disk', savedAt: NOW - DAY },
      ]),
    ).toMatchObject({ savedAt: NOW - 2 * DAY })
  })

  it('sourceLabel 快照显示日期，其余显示年龄', () => {
    expect(sourceLabel({ source: 'snapshot', savedAt: NOW - 10 * DAY }, NOW)).toBe(
      '内置快照（2026-07-06）',
    )
    expect(sourceLabel({ source: 'disk', savedAt: NOW - 3 * DAY }, NOW)).toBe(
      '本地缓存 · 3 天前',
    )
    expect(sourceLabel({ source: 'disk-stale', savedAt: NOW - 40 * DAY }, NOW)).toBe(
      '过期缓存 · 40 天前',
    )
    expect(sourceLabel({ source: 'network', savedAt: NOW }, NOW)).toBe(
      'KCNav 实时 · 刚刚',
    )
  })
})
