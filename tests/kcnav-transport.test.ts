import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createKcnavTransport,
  KcnavAutomationError,
  KcnavCooldownError,
} from '../src/services/kcnav-transport'

const HOUR = 60 * 60 * 1000

const newStatePath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'sortie-odds-transport-')), 'kcnav-state.json')

// setImmediate 未被伪造，用它把真实 IO（fs 读写）与微任务排空
const flushIO = async (rounds = 5): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

describe('kcnav-transport', () => {
  beforeEach(() => {
    // 只伪造计时器与 Date，保持 fs 等真实 IO 可用
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-07-16T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('串行执行并保持 ≥1.5s 间隔，interactive 插队', async () => {
    const calls: Array<{ url: string; at: number }> = []
    const transport = createKcnavTransport({
      fetchJson: async (url) => {
        calls.push({ url, at: Date.now() })
        return { url }
      },
      statePath: await newStatePath(),
      random: () => 0,
    })
    const b1 = transport.request('b1')
    const b2 = transport.request('b2')
    const i1 = transport.request('i1', { priority: 'interactive' })
    // b1 入队时 pump 立即启动并在途；i1 应插到 b2 之前
    await flushIO()
    await vi.advanceTimersByTimeAsync(1500)
    await flushIO()
    await vi.advanceTimersByTimeAsync(1500)
    await flushIO()
    await Promise.all([b1, b2, i1])
    expect(calls.map((call) => call.url)).toEqual(['b1', 'i1', 'b2'])
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1500)
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(1500)
  })

  it('401 automation 触发 6h 熔断、持久化，期间请求即拒不发包', async () => {
    const statePath = await newStatePath()
    const fetchJson = vi.fn(async () => {
      throw new KcnavAutomationError('bot detected')
    })
    const transport = createKcnavTransport({ fetchJson, statePath, random: () => 0 })
    await expect(transport.request('u1')).rejects.toBeInstanceOf(KcnavAutomationError)
    expect(transport.getStatus().state).toBe('cooldown')
    expect(transport.getStatus().cooldownUntil).toBe(Date.now() + 6 * HOUR)
    await expect(transport.request('u2')).rejects.toBeInstanceOf(KcnavCooldownError)
    expect(fetchJson).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      cooldownUntil: number
      cooldownLevel: number
    }
    expect(persisted.cooldownLevel).toBe(1)
    expect(persisted.cooldownUntil).toBe(Date.now() + 6 * HOUR)
  })

  it('重启后从状态文件恢复冷却', async () => {
    const statePath = await newStatePath()
    const first = createKcnavTransport({
      fetchJson: async () => {
        throw new KcnavAutomationError('bot')
      },
      statePath,
      random: () => 0,
    })
    await expect(first.request('u1')).rejects.toBeInstanceOf(KcnavAutomationError)
    const second = createKcnavTransport({
      fetchJson: vi.fn(async () => ({})),
      statePath,
      random: () => 0,
    })
    await expect(second.request('u2')).rejects.toBeInstanceOf(KcnavCooldownError)
  })

  it('probe 成功解除熔断并清零等级；再次 401 冷却翻倍且 24h 封顶', async () => {
    const statePath = await newStatePath()
    let mode: 'reject' | 'ok' = 'reject'
    const transport = createKcnavTransport({
      fetchJson: async () => {
        if (mode === 'reject') throw new KcnavAutomationError('bot')
        return {}
      },
      statePath,
      random: () => 0,
    })
    await expect(transport.request('u1')).rejects.toBeInstanceOf(KcnavAutomationError)
    expect(transport.getStatus().cooldownLevel).toBe(1)

    const p1 = transport.probe('p1')
    await flushIO()
    await vi.advanceTimersByTimeAsync(1500)
    await flushIO()
    expect(await p1).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(2)
    expect(transport.getStatus().cooldownUntil).toBe(Date.now() + 12 * HOUR)

    const p2 = transport.probe('p2')
    await flushIO()
    await vi.advanceTimersByTimeAsync(1500)
    await flushIO()
    expect(await p2).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(3)

    const p3 = transport.probe('p3')
    await flushIO()
    await vi.advanceTimersByTimeAsync(1500)
    await flushIO()
    expect(await p3).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(3)
    expect(transport.getStatus().cooldownUntil).toBe(Date.now() + 24 * HOUR)

    mode = 'ok'
    const p4 = transport.probe('p4')
    await flushIO()
    await vi.advanceTimersByTimeAsync(1500)
    await flushIO()
    expect(await p4).toBe(true)
    expect(transport.getStatus()).toMatchObject({
      state: 'ok',
      cooldownLevel: 0,
      cooldownUntil: 0,
    })
  })

  it('非 401 错误标记 offline 但不熔断', async () => {
    const transport = createKcnavTransport({
      fetchJson: async () => {
        throw new Error('timeout')
      },
      statePath: await newStatePath(),
      random: () => 0,
    })
    await expect(transport.request('u1')).rejects.toThrow('timeout')
    expect(transport.getStatus().state).toBe('offline')
  })
})
