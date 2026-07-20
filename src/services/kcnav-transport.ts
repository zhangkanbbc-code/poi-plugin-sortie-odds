import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { get } from 'node:https'
import { dirname, join } from 'node:path'

import { PLUGIN_UA } from '../constants'
import { cacheRoot } from './map-cache'

export type TransportPriority = 'interactive' | 'background'

export interface KcnavStatus {
  state: 'ok' | 'offline' | 'cooldown'
  cooldownUntil: number
  cooldownLevel: number
  queueLength: number
}

export class KcnavAutomationError extends Error {
  constructor(detail: string) {
    super(`KCNav 已拒绝自动化请求：${detail}`)
    this.name = 'KcnavAutomationError'
  }
}

export class KcnavCooldownError extends Error {
  readonly until: number

  constructor(until: number) {
    super('KCNav 冷却中，暂不发起网络请求')
    this.name = 'KcnavCooldownError'
    this.until = until
  }
}

interface QueueJob {
  url: string
  timeoutMs: number
  priority: TransportPriority
  probe: boolean
  seq: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export interface KcnavTransport {
  request: <T>(
    url: string,
    options?: { priority?: TransportPriority; timeoutMs?: number },
  ) => Promise<T>
  probe: (url: string) => Promise<boolean>
  getStatus: () => KcnavStatus
  subscribe: (listener: (status: KcnavStatus) => void) => () => void
}

export interface TransportDeps {
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>
  statePath: string
  random?: () => number
}

const HOUR = 60 * 60 * 1000
const COOLDOWN_STEPS = [6 * HOUR, 12 * HOUR, 24 * HOUR]
const MIN_GAP_MS = 1500
const MAX_GAP_MS = 3000
const DEFAULT_TIMEOUT_MS = 7000

export const httpFetchJson = (url: string, timeoutMs: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const request = get(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': PLUGIN_UA } },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => {
          const status = response.statusCode ?? 0
          const text = Buffer.concat(chunks).toString('utf8')
          if (status === 401 && /automation/i.test(text)) {
            reject(new KcnavAutomationError(text.slice(0, 120)))
            return
          }
          if (status < 200 || status >= 300) {
            reject(new Error(`KCNav HTTP ${status}: ${text.slice(0, 160)}`))
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(new Error(`KCNav 返回了无效 JSON：${String(error)}`))
          }
        })
      },
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`KCNav 请求超过 ${Math.round(timeoutMs / 1000)} 秒`))
    })
    request.on('error', reject)
  })

export const createKcnavTransport = (deps: TransportDeps): KcnavTransport => {
  const random = deps.random ?? Math.random
  const queue: QueueJob[] = []
  const listeners = new Set<(status: KcnavStatus) => void>()
  let pumping = false
  let lastFinishedAt = 0
  let cooldownUntil = 0
  let cooldownLevel = 0
  let online = true
  let nextSeq = 1

  const getStatus = (): KcnavStatus => ({
    state: Date.now() < cooldownUntil ? 'cooldown' : online ? 'ok' : 'offline',
    cooldownUntil,
    cooldownLevel,
    queueLength: queue.length,
  })

  const notify = (): void => {
    const status = getStatus()
    for (const listener of listeners) listener(status)
  }

  const persistState = async (): Promise<void> => {
    try {
      await mkdir(dirname(deps.statePath), { recursive: true })
      await writeFile(
        deps.statePath,
        JSON.stringify({ cooldownUntil, cooldownLevel }),
        'utf8',
      )
    } catch {
      // 状态写不进磁盘时冷却只在本次会话内生效
    }
  }

  const stateLoaded = (async () => {
    try {
      const raw = JSON.parse(await readFile(deps.statePath, 'utf8')) as {
        cooldownUntil?: number
        cooldownLevel?: number
      }
      cooldownUntil = Number(raw.cooldownUntil) || 0
      cooldownLevel = Math.min(
        Math.max(Number(raw.cooldownLevel) || 0, 0),
        COOLDOWN_STEPS.length,
      )
    } catch {
      // 无历史状态
    }
  })()

  const escalateCooldown = async (): Promise<void> => {
    cooldownLevel = Math.min(cooldownLevel + 1, COOLDOWN_STEPS.length)
    cooldownUntil = Date.now() + COOLDOWN_STEPS[cooldownLevel - 1]
    await persistState()
  }

  const clearCooldown = async (): Promise<void> => {
    if (cooldownUntil === 0 && cooldownLevel === 0) return
    cooldownUntil = 0
    cooldownLevel = 0
    await persistState()
  }

  const takeNext = (): QueueJob => {
    let best = 0
    for (let index = 1; index < queue.length; index += 1) {
      const candidate = queue[index]
      const current = queue[best]
      const candidateInteractive = candidate.priority === 'interactive'
      const currentInteractive = current.priority === 'interactive'
      if (candidateInteractive !== currentInteractive) {
        if (candidateInteractive) best = index
      } else if (candidate.seq < current.seq) {
        best = index
      }
    }
    return queue.splice(best, 1)[0]
  }

  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    while (queue.length > 0) {
      const gap = MIN_GAP_MS + (MAX_GAP_MS - MIN_GAP_MS) * random()
      const waitMs = Math.max(0, lastFinishedAt + gap - Date.now())
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
      const job = takeNext()
      if (Date.now() < cooldownUntil && !job.probe) {
        job.reject(new KcnavCooldownError(cooldownUntil))
        notify()
        continue
      }
      try {
        const value = await deps.fetchJson(job.url, job.timeoutMs)
        online = true
        await clearCooldown()
        job.resolve(value)
      } catch (error) {
        if (error instanceof KcnavAutomationError) {
          await escalateCooldown()
        } else if (!(error instanceof KcnavCooldownError)) {
          online = false
        }
        job.reject(error instanceof Error ? error : new Error(String(error)))
      } finally {
        lastFinishedAt = Date.now()
        notify()
      }
    }
    pumping = false
  }

  const enqueue = <T>(
    url: string,
    priority: TransportPriority,
    timeoutMs: number,
    probe: boolean,
  ): Promise<T> =>
    stateLoaded.then(() => {
      if (!probe && Date.now() < cooldownUntil) {
        throw new KcnavCooldownError(cooldownUntil)
      }
      return new Promise<T>((resolve, reject) => {
        queue.push({
          url,
          priority,
          timeoutMs,
          probe,
          seq: nextSeq++,
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        notify()
        void pump()
      })
    })

  return {
    request: <T>(
      url: string,
      options?: { priority?: TransportPriority; timeoutMs?: number },
    ) =>
      enqueue<T>(
        url,
        options?.priority ?? 'background',
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        false,
      ),
    probe: async (url: string): Promise<boolean> => {
      try {
        await enqueue(url, 'interactive', DEFAULT_TIMEOUT_MS, true)
        return true
      } catch {
        return false
      }
    },
    getStatus,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const kcnavTransport = createKcnavTransport({
  fetchJson: httpFetchJson,
  statePath: join(cacheRoot, 'kcnav-state.json'),
})
