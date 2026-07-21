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
const flushIO = async (rounds = 1): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// 曾经的写法是"固定跑几轮 flushIO，再一次性推进 1500ms 假时钟"，隐含假设
// 是"真实 IO（enqueue 内部等待的 statePath 读取）一定能在这几轮 setImmediate
// 内跑完"。本地几乎总成立，但 GitHub 共享跑者偶尔慢一点就会打破这个假设：
// 假时钟被推到真实 IO 前面时，pump() 里之后才补挂上的 setTimeout 永远没人
// 再推进，测试直接死锁（不是变慢，加多大的超时都没用，这也是为什么第一次
// 把超时从 5s 提到 20s 完全没用）。
// 改成小步循环：每轮只让真实 IO 走一格、假时钟走一点，直到目标 Promise 落定
// 为止——不管真实 IO 到底要几轮 tick 才能跑完，迟早会追上
// runUntilSettled 为了不死锁会多做几轮真实 IO 等待，可能把假时钟多推进
// 数百毫秒到几秒（受 maxRounds×25ms 预算约束）——这点漂移在"小时"级的冷却
// 时长面前可以忽略，所以冷却到期时间改用容差断言，不再要求与 Date.now() 精确相等
const expectCooldownAbout = (cooldownUntil: number, hours: number): void => {
  const remaining = cooldownUntil - Date.now()
  expect(remaining).toBeGreaterThan(hours * HOUR - 30_000)
  expect(remaining).toBeLessThanOrEqual(hours * HOUR)
}

const runUntilSettled = async (target: Promise<unknown>, maxRounds = 400): Promise<void> => {
  let done = false
  target.then(() => { done = true }, () => { done = true })
  for (let round = 0; round < maxRounds && !done; round += 1) {
    // 先只推进真实 IO 并检查——如果这一轮单靠真实 IO 落地的（比如 persistState
    // 的 mkdir+writeFile 收尾）就不要再多推一次假时钟，否则 Date.now() 会被
    // 无谓地推到 cooldownUntil 快照之后，冲掉"发生在几点"的断言
    await flushIO(3)
    if (done) return
    await vi.advanceTimersByTimeAsync(25)
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
    await runUntilSettled(Promise.all([b1, b2, i1]))
    await Promise.all([b1, b2, i1])
    expect(calls.map((call) => call.url)).toEqual(['b1', 'i1', 'b2'])
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1500)
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(1500)
  }, 10_000)

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
    await runUntilSettled(p1)
    expect(await p1).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(2)
    expectCooldownAbout(transport.getStatus().cooldownUntil, 12)

    const p2 = transport.probe('p2')
    await runUntilSettled(p2)
    expect(await p2).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(3)

    const p3 = transport.probe('p3')
    await runUntilSettled(p3)
    expect(await p3).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(3)
    expectCooldownAbout(transport.getStatus().cooldownUntil, 24)

    mode = 'ok'
    const p4 = transport.probe('p4')
    await runUntilSettled(p4)
    expect(await p4).toBe(true)
    expect(transport.getStatus()).toMatchObject({
      state: 'ok',
      cooldownLevel: 0,
      cooldownUntil: 0,
    })
  }, 10_000)

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
