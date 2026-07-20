# KCNav 缓存治理实施计划（v0.4.0 / v0.4.1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件对 KCNav 的请求串行节流、401 自动熔断、全图磁盘缓存并内置通常图数据快照，日常通常图零请求。

**Architecture:** 新增传输层 `kcnav-transport.ts`（串行队列+熔断+持久化）与缓存层 `map-cache.ts`（maps-v2 磁盘缓存、v1 迁移、内置快照读取），`kcnav.ts` 重写为按解析顺序组合两层的数据客户端并返回来源元数据；视图层增加状态 Tag、数据年龄与刷新/试探按钮。开发侧脚本一次性抓取通常图快照打包进 `data/`。

**Tech Stack:** TypeScript（strict）、React 18 + Blueprint 4、tsdown（CJS 单文件）、vitest、node:https / node:fs/promises。

**对应 spec:** `docs/superpowers/specs/2026-07-16-kcnav-cache-governance-design.md`

## Global Constraints

- **本项目不使用 git（用户决定）**：计划里的"提交"一律替换为验证门 `npm run check`（lint + typecheck + test + build），里程碑用 `npm pack` 产出 tgz 留存。
- 项目根目录：`C:\Users\User\Documents\Codex\2026-07-15\new-chat-4\outputs\poi-plugin-sortie-odds`（下文所有相对路径以此为根）。
- 不新增任何 runtime 依赖；node 内置模块一律 `node:` 前缀（tsdown 自动外部化，现有 kcnav.ts 已用 `node:fs/promises` 且构建正常，无需改 tsdown.config.ts）。
- 用户可见文案一律中文；代码注释仅在表达代码本身无法表达的约束时才写。
- import 顺序遵循现有 eslint 配置：node 内置 → 外部包 → 相对路径，组间空行，组内字母序。
- TTL 常量（来自 spec，不得改动）：通常图（世界 1~9）map/enemy/evidence 均 30 天；活动图 map 24h、enemy 12h、evidence 24h。
- 队列间隔 1.5~3 秒随机；熔断 6h → 12h → 24h 封顶；探测成功清零等级。
- 缓存路径：`<poi数据目录>/sortie-odds-cache/`，其下 `maps-v2/<mapId>/`、`normal-maps-v1/<mapId>/`（旧，只读迁移）、`kcnav-state.json`。
- 安装目录（部署验证用）：`%APPDATA%\poi\plugins-extra\node_modules\poi-plugin-sortie-odds`。
- 测试命令：`npm run test`（vitest run）；单文件 `npx vitest run tests/<file>.test.ts`。

---

### Task 1: 缓存层 map-cache（maps-v2 + v1 迁移 + 快照读取）

**Files:**
- Create: `src/services/map-cache.ts`
- Create: `tests/map-cache.test.ts`
- Modify: `src/constants.ts`（新增 `PLUGIN_UA`）

**Interfaces:**
- Consumes: 无（最底层，只依赖 node:fs / node:path）
- Produces（后续任务依赖的确切签名）:
  - `type DataSource = 'network' | 'disk' | 'disk-stale' | 'snapshot'`
  - `interface CachedResource<T> { value: T; savedAt: number; source: DataSource }`
  - `type ResourceKind = 'map' | 'enemy' | 'evidence'`
  - `isNormalMap(mapId: string): boolean`
  - `ttlFor(mapId: string, kind: ResourceKind): number`
  - `interface MapCache { readFresh<T>(mapId, name, kind): Promise<CachedResource<T> | null>; readSnapshot<T>(mapId, name): Promise<CachedResource<T> | null>; readStale<T>(mapId, name): Promise<CachedResource<T> | null>; write<T>(mapId, name, value, savedAt?): Promise<void> }`
  - `createMapCache(deps?: { v2Root?: string; v1Root?: string; snapshotRoot?: string | null }): MapCache`
  - 单例 `mapCache`、常量 `cacheRoot`、`poiDataPath`
  - constants: `PLUGIN_UA = 'poi-plugin-sortie-odds/0.4.0'`

- [ ] **Step 1: 在 `src/constants.ts` 末尾追加 UA 常量**

```ts
export const PLUGIN_UA = 'poi-plugin-sortie-odds/0.4.0'
```

- [ ] **Step 2: 写失败测试 `tests/map-cache.test.ts`**

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMapCache, ttlFor } from '../src/services/map-cache'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const makeRoots = async () => {
  const base = await mkdtemp(join(tmpdir(), 'sortie-odds-cache-'))
  return {
    v2Root: join(base, 'maps-v2'),
    v1Root: join(base, 'normal-maps-v1'),
    snapshotRoot: join(base, 'snapshot'),
  }
}

const writeEntry = async (root: string, mapId: string, name: string, savedAt: number, value: unknown) => {
  await mkdir(join(root, mapId), { recursive: true })
  await writeFile(join(root, mapId, name), JSON.stringify({ savedAt, value }), 'utf8')
}

describe('map-cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-16T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('TTL 分档：通常图 30 天，活动图 map 24h / enemy 12h / evidence 24h', () => {
    expect(ttlFor('1-5', 'map')).toBe(30 * DAY)
    expect(ttlFor('1-5', 'enemy')).toBe(30 * DAY)
    expect(ttlFor('55-3', 'map')).toBe(DAY)
    expect(ttlFor('55-3', 'enemy')).toBe(12 * HOUR)
    expect(ttlFor('55-3', 'evidence')).toBe(DAY)
  })

  it('readFresh 命中 v2 且未过期', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    await writeEntry(roots.v2Root, '2-1', 'map.json', Date.now() - DAY, { ok: 1 })
    const hit = await cache.readFresh<{ ok: number }>('2-1', 'map.json', 'map')
    expect(hit).toMatchObject({ value: { ok: 1 }, source: 'disk' })
  })

  it('v2 未命中时迁移读取 v1 并保留原时间戳', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    const savedAt = Date.now() - 2 * DAY
    await writeEntry(roots.v1Root, '1-5', 'enemy-3.json', savedAt, { legacy: true })
    const hit = await cache.readFresh<{ legacy: boolean }>('1-5', 'enemy-3.json', 'enemy')
    expect(hit).toMatchObject({ value: { legacy: true }, savedAt, source: 'disk' })
    const migrated = await createMapCache({ ...roots, v1Root: join(roots.v1Root, 'gone') })
      .readFresh<{ legacy: boolean }>('1-5', 'enemy-3.json', 'enemy')
    expect(migrated).toMatchObject({ value: { legacy: true }, savedAt })
  })

  it('活动图敌编成 13 小时后过期，readStale 仍可读', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    await writeEntry(roots.v2Root, '55-3', 'enemy-8.json', Date.now() - 13 * HOUR, { e: 1 })
    expect(await cache.readFresh('55-3', 'enemy-8.json', 'enemy')).toBeNull()
    expect(await cache.readStale('55-3', 'enemy-8.json')).toMatchObject({
      value: { e: 1 },
      source: 'disk-stale',
    })
  })

  it('readSnapshot 只对通常图生效，来源标记 snapshot', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    const generatedAt = Date.now() - 40 * DAY
    await writeEntry(roots.snapshotRoot, '3-2', 'map.json', generatedAt, { snap: 1 })
    await writeEntry(roots.snapshotRoot, '55-1', 'map.json', generatedAt, { snap: 2 })
    expect(await cache.readSnapshot('3-2', 'map.json')).toMatchObject({
      value: { snap: 1 },
      savedAt: generatedAt,
      source: 'snapshot',
    })
    expect(await cache.readSnapshot('55-1', 'map.json')).toBeNull()
  })

  it('write 后 readFresh 立即可见', async () => {
    const roots = await makeRoots()
    const cache = createMapCache(roots)
    await cache.write('55-3', 'map.json', { fresh: true })
    expect(await cache.readFresh('55-3', 'map.json', 'map')).toMatchObject({
      value: { fresh: true },
      source: 'disk',
    })
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run tests/map-cache.test.ts`
Expected: FAIL —— `Cannot find module '../src/services/map-cache'`

- [ ] **Step 4: 实现 `src/services/map-cache.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type DataSource = 'network' | 'disk' | 'disk-stale' | 'snapshot'

export interface CachedResource<T> {
  value: T
  savedAt: number
  source: DataSource
}

export type ResourceKind = 'map' | 'enemy' | 'evidence'

interface DiskEntry<T> {
  savedAt: number
  value: T
}

export const poiDataPath = typeof window !== 'undefined' && window.APPDATA_PATH
  ? window.APPDATA_PATH
  : join(process.env.APPDATA ?? process.cwd(), 'poi')

export const cacheRoot = join(poiDataPath, 'sortie-odds-cache')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NORMAL_TTL = 30 * DAY
const EVENT_TTL: Record<ResourceKind, number> = {
  map: DAY,
  enemy: 12 * HOUR,
  evidence: DAY,
}

export const isNormalMap = (mapId: string): boolean => {
  const world = Number(mapId.split('-')[0])
  return world > 0 && world < 10
}

export const ttlFor = (mapId: string, kind: ResourceKind): number =>
  isNormalMap(mapId) ? NORMAL_TTL : EVENT_TTL[kind]

const safeMapId = (mapId: string): string =>
  /^\d+-\d+$/.test(mapId) ? mapId : 'invalid'

export interface MapCacheDeps {
  v2Root?: string
  v1Root?: string
  snapshotRoot?: string | null
}

export interface MapCache {
  readFresh: <T>(mapId: string, name: string, kind: ResourceKind) => Promise<CachedResource<T> | null>
  readSnapshot: <T>(mapId: string, name: string) => Promise<CachedResource<T> | null>
  readStale: <T>(mapId: string, name: string) => Promise<CachedResource<T> | null>
  write: <T>(mapId: string, name: string, value: T, savedAt?: number) => Promise<void>
}

export const createMapCache = (deps: MapCacheDeps = {}): MapCache => {
  const v2Root = deps.v2Root ?? join(cacheRoot, 'maps-v2')
  const v1Root = deps.v1Root ?? join(cacheRoot, 'normal-maps-v1')
  const snapshotRoot = deps.snapshotRoot === undefined
    ? join(__dirname, 'data', 'normal-maps')
    : deps.snapshotRoot
  const memory = new Map<string, DiskEntry<unknown>>()

  const readEntry = async <T>(path: string): Promise<DiskEntry<T> | null> => {
    const cached = memory.get(path) as DiskEntry<T> | undefined
    if (cached) return cached
    try {
      const entry = JSON.parse(await readFile(path, 'utf8')) as DiskEntry<T>
      if (typeof entry?.savedAt !== 'number') return null
      memory.set(path, entry)
      return entry
    } catch {
      return null
    }
  }

  const write = async <T>(
    mapId: string,
    name: string,
    value: T,
    savedAt = Date.now(),
  ): Promise<void> => {
    const path = join(v2Root, safeMapId(mapId), name)
    const entry: DiskEntry<T> = { savedAt, value }
    try {
      await mkdir(join(v2Root, safeMapId(mapId)), { recursive: true })
      await writeFile(path, JSON.stringify(entry), 'utf8')
      memory.set(path, entry)
    } catch {
      // 只读数据目录不阻断在线分析
    }
  }

  const readAny = async <T>(mapId: string, name: string): Promise<DiskEntry<T> | null> => {
    const v2 = await readEntry<T>(join(v2Root, safeMapId(mapId), name))
    if (v2) return v2
    const v1 = await readEntry<T>(join(v1Root, safeMapId(mapId), name))
    if (v1) {
      await write(mapId, name, v1.value, v1.savedAt)
      return v1
    }
    return null
  }

  return {
    readFresh: async <T>(mapId: string, name: string, kind: ResourceKind) => {
      const entry = await readAny<T>(mapId, name)
      if (!entry || Date.now() - entry.savedAt > ttlFor(mapId, kind)) return null
      return { value: entry.value, savedAt: entry.savedAt, source: 'disk' as const }
    },
    readSnapshot: async <T>(mapId: string, name: string) => {
      if (!snapshotRoot || !isNormalMap(mapId)) return null
      const entry = await readEntry<T>(join(snapshotRoot, safeMapId(mapId), name))
      if (!entry) return null
      return { value: entry.value, savedAt: entry.savedAt, source: 'snapshot' as const }
    },
    readStale: async <T>(mapId: string, name: string) => {
      const entry = await readAny<T>(mapId, name)
      if (!entry) return null
      return { value: entry.value, savedAt: entry.savedAt, source: 'disk-stale' as const }
    },
    write,
  }
}

export const mapCache = createMapCache()
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/map-cache.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 6: 验证门**

Run: `npm run check`
Expected: lint / typecheck / test / build 全部通过（注意：`window.APPDATA_PATH` 与全局 `PoiRootState` 的声明沿用现有 shims，若 typecheck 报 window 属性缺失，参照 kcnav.ts 原有写法保持一致即可——原文件同样访问了 `window.APPDATA_PATH` 且通过 typecheck）

---

### Task 2: 传输层 kcnav-transport（串行队列 + 401 熔断 + 持久化）

**Files:**
- Create: `src/services/kcnav-transport.ts`
- Create: `tests/kcnav-transport.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `cacheRoot`；constants 的 `PLUGIN_UA`
- Produces（后续任务依赖的确切签名）:
  - `type TransportPriority = 'interactive' | 'background'`
  - `interface KcnavStatus { state: 'ok' | 'offline' | 'cooldown'; cooldownUntil: number; cooldownLevel: number; queueLength: number }`
  - `class KcnavAutomationError extends Error`
  - `class KcnavCooldownError extends Error { readonly until: number }`
  - `interface KcnavTransport { request<T>(url: string, options?: { priority?: TransportPriority; timeoutMs?: number }): Promise<T>; probe(url: string): Promise<boolean>; getStatus(): KcnavStatus; subscribe(listener: (s: KcnavStatus) => void): () => void }`
  - `createKcnavTransport(deps: { fetchJson: (url: string, timeoutMs: number) => Promise<unknown>; statePath: string; random?: () => number }): KcnavTransport`
  - `httpFetchJson(url: string, timeoutMs: number): Promise<unknown>`（默认实现，401+automation → 抛 `KcnavAutomationError`）
  - 单例 `kcnavTransport`

- [ ] **Step 1: 写失败测试 `tests/kcnav-transport.test.ts`**

```ts
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
    await vi.advanceTimersByTimeAsync(1600)
    await vi.advanceTimersByTimeAsync(1600)
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

    await vi.advanceTimersByTimeAsync(1600)
    expect(await transport.probe('p1')).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(2)
    expect(transport.getStatus().cooldownUntil).toBe(Date.now() + 12 * HOUR)

    await vi.advanceTimersByTimeAsync(1600)
    expect(await transport.probe('p2')).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(3)

    await vi.advanceTimersByTimeAsync(1600)
    expect(await transport.probe('p3')).toBe(false)
    expect(transport.getStatus().cooldownLevel).toBe(3)
    expect(transport.getStatus().cooldownUntil).toBe(Date.now() + 24 * HOUR)

    mode = 'ok'
    await vi.advanceTimersByTimeAsync(1600)
    expect(await transport.probe('p4')).toBe(true)
    expect(transport.getStatus()).toMatchObject({ state: 'ok', cooldownLevel: 0, cooldownUntil: 0 })
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/kcnav-transport.test.ts`
Expected: FAIL —— `Cannot find module '../src/services/kcnav-transport'`

- [ ] **Step 3: 实现 `src/services/kcnav-transport.ts`**

```ts
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

  const escalateCooldown = (): void => {
    cooldownLevel = Math.min(cooldownLevel + 1, COOLDOWN_STEPS.length)
    cooldownUntil = Date.now() + COOLDOWN_STEPS[cooldownLevel - 1]
    void persistState()
  }

  const clearCooldown = (): void => {
    if (cooldownUntil === 0 && cooldownLevel === 0) return
    cooldownUntil = 0
    cooldownLevel = 0
    void persistState()
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
        clearCooldown()
        job.resolve(value)
      } catch (error) {
        if (error instanceof KcnavAutomationError) {
          escalateCooldown()
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/kcnav-transport.test.ts`
Expected: PASS（5 个用例全绿）。若「串行间隔」用例超时：检查 pump 中 `waitMs > 0` 分支是否用了未被 fake 的计时器 API（只允许 setTimeout）。

- [ ] **Step 5: 验证门**

Run: `npm run check`
Expected: 全绿

---

### Task 3: 数据客户端 kcnav.ts 重写（解析顺序 + evidence 缓存键 + 去重）

**Files:**
- Modify: `src/services/kcnav.ts`（整体重写）
- Create: `tests/kcnav.test.ts`

**Interfaces:**
- Consumes: Task 1 `MapCache`/`mapCache`/`CachedResource`/`isNormalMap`；Task 2 `KcnavTransport`/`kcnavTransport`/`KcnavAutomationError`/`KcnavCooldownError`/`TransportPriority`
- Produces（后续任务依赖的确切签名）:
  - `interface LoadOptions { force?: boolean; priority?: TransportPriority }`
  - `evidenceKey(mapId: string, edgeIds: number[], features: RoutingFleetFeatures): string`
  - `createKcnavClient(transport: KcnavTransport, cache: MapCache): KcnavClient`
  - `interface KcnavClient { loadMap(mapId, options?): Promise<CachedResource<KcnavMapPayload>>; loadEnemyComps(mapId, edgeId, options?): Promise<CachedResource<KcnavEnemyPayload>>; loadRouteEvidence(mapId, edgeIds, features, options?): Promise<CachedResource<KcnavRouteEntryPayload>> }`
  - 绑定单例导出：`loadMap`、`loadEnemyComps`、`loadRouteEvidence`
  - **临时兼容导出（Task 5 移除）**：`fetchMap(mapId)` / `fetchEnemyComps(mapId, edgeId)` / `fetchRouteEntries(mapId, edgeIds, features)`，内部调 loadX 后返回 `.value`，保证本任务结束时 `views/index.tsx` 不改也能编译

- [ ] **Step 1: 写失败测试 `tests/kcnav.test.ts`**

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createKcnavClient, evidenceKey } from '../src/services/kcnav'
import { createMapCache } from '../src/services/map-cache'
import type { KcnavTransport } from '../src/services/kcnav-transport'
import type { RoutingFleetFeatures } from '../src/types'

const makeRoots = async () => {
  const base = await mkdtemp(join(tmpdir(), 'sortie-odds-client-'))
  return {
    v2Root: join(base, 'maps-v2'),
    v1Root: join(base, 'normal-maps-v1'),
    snapshotRoot: join(base, 'snapshot'),
  }
}

const writeEntry = async (root: string, mapId: string, name: string, savedAt: number, value: unknown) => {
  await mkdir(join(root, mapId), { recursive: true })
  await writeFile(join(root, mapId, name), JSON.stringify({ savedAt, value }), 'utf8')
}

const fakeTransport = (
  impl: (url: string) => Promise<unknown>,
): { transport: KcnavTransport; requestMock: ReturnType<typeof vi.fn> } => {
  const requestMock = vi.fn(impl)
  return {
    transport: {
      request: requestMock as KcnavTransport['request'],
      probe: async () => true,
      getStatus: () => ({ state: 'ok', cooldownUntil: 0, cooldownLevel: 0, queueLength: 0 }),
      subscribe: () => () => undefined,
    },
    requestMock,
  }
}

const features: RoutingFleetFeatures = {
  fleetType: 0,
  fleetNum: 1,
  mainComp: 'DD DD CL',
  escortComp: '',
  radars: 2,
  drums: 0,
}

const mapPayload = { result: { route: { '0': [null, '1', 0, 0] } } }
const enemyPayload = { result: { entryCount: 1, entries: [{ formation: 1, count: 3, fleet: [] }] } }
const emptyEnemyPayload = { result: { entryCount: 0, entries: [] } }

describe('kcnav client', () => {
  it('通常图：磁盘新数据优先，不发网络请求', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.v2Root, '2-1', 'map.json', Date.now(), mapPayload)
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadMap('2-1')
    expect(result.source).toBe('disk')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('通常图：无磁盘时用快照，不发网络请求', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.snapshotRoot, '2-1', 'map.json', Date.now() - 90 * 86400000, mapPayload)
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadMap('2-1')
    expect(result.source).toBe('snapshot')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('通常图：什么都没有才走网络并写盘', async () => {
    const roots = await makeRoots()
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const cache = createMapCache(roots)
    const client = createKcnavClient(transport, cache)
    const first = await client.loadMap('2-1')
    expect(first.source).toBe('network')
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(await cache.readFresh('2-1', 'map.json', 'map')).not.toBeNull()
  })

  it('force 时即使磁盘有新数据也走网络', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.v2Root, '2-1', 'map.json', Date.now(), mapPayload)
    const { transport, requestMock } = fakeTransport(async () => mapPayload)
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadMap('2-1', { force: true })
    expect(result.source).toBe('network')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('活动图：磁盘新→网络→网络失败回退陈旧缓存', async () => {
    const roots = await makeRoots()
    await writeEntry(roots.v2Root, '55-1', 'enemy-3.json', Date.now() - 20 * 86400000, enemyPayload)
    const { transport } = fakeTransport(async () => {
      throw new Error('network down')
    })
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadEnemyComps('55-1', 3)
    expect(result.source).toBe('disk-stale')
    expect(result.value.result.entries.length).toBe(1)
  })

  it('敌编成第一窗口为空时尝试第二窗口', async () => {
    const roots = await makeRoots()
    const responses = [emptyEnemyPayload, enemyPayload]
    const { transport, requestMock } = fakeTransport(async () => responses.shift())
    const client = createKcnavClient(transport, createMapCache(roots))
    const result = await client.loadEnemyComps('2-1', 5)
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(result.value.result.entries.length).toBe(1)
  })

  it('带路核验按图+路线+特征缓存，第二次不再请求', async () => {
    const roots = await makeRoots()
    const payload = { result: { entries: [{}], pageCount: 1 } }
    const { transport, requestMock } = fakeTransport(async () => payload)
    const client = createKcnavClient(transport, createMapCache(roots))
    await client.loadRouteEvidence('2-1', [1, 2, 8], features)
    await client.loadRouteEvidence('2-1', [1, 2, 8], features)
    expect(requestMock).toHaveBeenCalledTimes(1)
    await client.loadRouteEvidence('2-1', [1, 2, 8], { ...features, radars: 3 })
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('evidenceKey 稳定且对特征敏感', () => {
    const a = evidenceKey('2-1', [1, 2, 8], features)
    expect(evidenceKey('2-1', [1, 2, 8], { ...features })).toBe(a)
    expect(evidenceKey('2-1', [1, 2, 9], features)).not.toBe(a)
    expect(evidenceKey('2-1', [1, 2, 8], { ...features, drums: 4 })).not.toBe(a)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/kcnav.test.ts`
Expected: FAIL —— `createKcnavClient` / `evidenceKey` 未导出

- [ ] **Step 3: 重写 `src/services/kcnav.ts`**

原文件的 memoryCache / inFlight / getJson / readDisk / writeDisk / clearKcnavCache 全部删除（职责已移交 transport 与 map-cache）。新内容：

```ts
import { KCNAV_BASE_URL } from '../constants'
import {
  KcnavAutomationError,
  KcnavCooldownError,
  kcnavTransport,
} from './kcnav-transport'
import { isNormalMap, mapCache } from './map-cache'
import type { KcnavTransport, TransportPriority } from './kcnav-transport'
import type { CachedResource, MapCache, ResourceKind } from './map-cache'
import type {
  KcnavEnemyPayload,
  KcnavMapPayload,
  KcnavRouteEntryPayload,
  RoutingFleetFeatures,
} from '../types'

export interface LoadOptions {
  force?: boolean
  priority?: TransportPriority
}

export interface KcnavClient {
  loadMap: (
    mapId: string,
    options?: LoadOptions,
  ) => Promise<CachedResource<KcnavMapPayload>>
  loadEnemyComps: (
    mapId: string,
    edgeId: number,
    options?: LoadOptions,
  ) => Promise<CachedResource<KcnavEnemyPayload>>
  loadRouteEvidence: (
    mapId: string,
    edgeIds: number[],
    features: RoutingFleetFeatures,
    options?: LoadOptions,
  ) => Promise<CachedResource<KcnavRouteEntryPayload>>
}

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

export const evidenceKey = (
  mapId: string,
  edgeIds: number[],
  features: RoutingFleetFeatures,
): string => {
  const raw = JSON.stringify([
    mapId,
    edgeIds,
    features.fleetType,
    features.fleetNum,
    features.mainComp,
    features.escortComp,
    features.radars,
    features.drums,
  ])
  let hash = 5381
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash * 33) ^ raw.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const createKcnavClient = (
  transport: KcnavTransport,
  cache: MapCache,
): KcnavClient => {
  const inFlight = new Map<string, Promise<CachedResource<unknown>>>()

  const dedupe = <T>(
    key: string,
    run: () => Promise<CachedResource<T>>,
  ): Promise<CachedResource<T>> => {
    const pending = inFlight.get(key) as Promise<CachedResource<T>> | undefined
    if (pending) return pending
    const promise = run().finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key)
    })
    inFlight.set(key, promise as Promise<CachedResource<unknown>>)
    return promise
  }

  const resolveResource = async <T>(
    mapId: string,
    name: string,
    kind: ResourceKind,
    fetchRemote: () => Promise<T>,
    shouldPersist: (value: T) => boolean,
    options?: LoadOptions,
  ): Promise<CachedResource<T>> => {
    if (!options?.force) {
      const fresh = await cache.readFresh<T>(mapId, name, kind)
      if (fresh) return fresh
      if (isNormalMap(mapId)) {
        const snapshot = await cache.readSnapshot<T>(mapId, name)
        if (snapshot) return snapshot
        const stale = await cache.readStale<T>(mapId, name)
        if (stale) return stale
      }
    }
    try {
      const value = await fetchRemote()
      if (shouldPersist(value)) await cache.write(mapId, name, value)
      return { value, savedAt: Date.now(), source: 'network' }
    } catch (error) {
      if (!options?.force) {
        const stale = await cache.readStale<T>(mapId, name)
        if (stale) return stale
        const snapshot = await cache.readSnapshot<T>(mapId, name)
        if (snapshot) return snapshot
      }
      throw error
    }
  }

  return {
    loadMap: (mapId, options) =>
      dedupe(`map:${mapId}:${options?.force ? 'f' : ''}`, () =>
        resolveResource<KcnavMapPayload>(
          mapId,
          'map.json',
          'map',
          () =>
            transport.request(
              `${KCNAV_BASE_URL}/maps/${encodeURIComponent(mapId)}`,
              options,
            ),
          () => true,
          options,
        )),
    loadEnemyComps: (mapId, edgeId, options) =>
      dedupe(`enemy:${mapId}:${edgeId}:${options?.force ? 'f' : ''}`, () =>
        resolveResource<KcnavEnemyPayload>(
          mapId,
          `enemy-${edgeId}.json`,
          'enemy',
          async () => {
            const windows = isNormalMap(mapId) ? [180, 45] : [90, 21]
            let lastError: unknown
            for (const days of windows) {
              const params = new URLSearchParams({
                start: isoDaysAgo(days),
                compsLimit: '100',
              })
              try {
                const payload = await transport.request<KcnavEnemyPayload>(
                  `${KCNAV_BASE_URL}/maps/${encodeURIComponent(mapId)}/edges/${edgeId}/enemycomps?${params.toString()}`,
                  options,
                )
                if (payload.result?.entries?.length) return payload
                lastError = new Error(`${mapId} 边 ${edgeId} 没有可用敌编成数据`)
              } catch (error) {
                lastError = error
                if (
                  error instanceof KcnavCooldownError
                  || error instanceof KcnavAutomationError
                ) break
              }
            }
            throw lastError instanceof Error
              ? lastError
              : new Error('KCNav 敌编成暂时不可用')
          },
          (payload) => !!payload.result?.entries?.length,
          options,
        )),
    loadRouteEvidence: (mapId, edgeIds, features, options) => {
      const name = `evidence-${evidenceKey(mapId, edgeIds, features)}.json`
      return dedupe(`evidence:${mapId}:${name}`, () =>
        resolveResource<KcnavRouteEntryPayload>(
          mapId,
          name,
          'evidence',
          () => {
            const params = new URLSearchParams({
              page: '0',
              perPage: '1',
              fleetType: String(features.fleetType),
              fleetNum: String(features.fleetNum),
              mainComp: features.mainComp,
              useMainFs: 'false',
              minRadars: String(features.radars),
              maxRadars: String(features.radars),
              minDrums: String(features.drums),
              maxDrums: String(features.drums),
            })
            if (features.escortComp) {
              params.set('escortComp', features.escortComp)
              params.set('useEscortFs', 'false')
            }
            if (isNormalMap(mapId)) params.set('start', isoDaysAgo(180))
            return transport.request(
              `${KCNAV_BASE_URL}/maps/${encodeURIComponent(mapId)}/edges/${edgeIds.join(',')}/entries?${params.toString()}`,
              options,
            )
          },
          () => true,
          options,
        ))
    },
  }
}

const defaultClient = createKcnavClient(kcnavTransport, mapCache)

export const loadMap = defaultClient.loadMap
export const loadEnemyComps = defaultClient.loadEnemyComps
export const loadRouteEvidence = defaultClient.loadRouteEvidence

// 临时兼容导出：Task 5 改造 views 后删除
export const fetchMap = async (mapId: string): Promise<KcnavMapPayload> =>
  (await loadMap(mapId)).value
export const fetchEnemyComps = async (
  mapId: string,
  edgeId: number,
): Promise<KcnavEnemyPayload> => (await loadEnemyComps(mapId, edgeId)).value
export const fetchRouteEntries = async (
  mapId: string,
  edgeIds: number[],
  features: RoutingFleetFeatures,
): Promise<KcnavRouteEntryPayload> =>
  (await loadRouteEvidence(mapId, edgeIds, features)).value
```

注意：evidence 结果**空也持久化**（"暂无记录"也是有效结论，TTL 控制时效）；enemy 空结果不持久化（与旧行为一致）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/kcnav.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: 验证门（确认 views 经兼容导出仍编译通过）**

Run: `npm run check`
Expected: 全绿

---

### Task 4: 数据来源展示助手 data-meta

**Files:**
- Create: `src/services/data-meta.ts`
- Create: `tests/data-meta.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DataSource`
- Produces:
  - `interface DataMeta { source: DataSource; savedAt: number }`
  - `summarizeResources(resources: DataMeta[]): DataMeta | null`（取"最差"来源：network < disk < snapshot < disk-stale；同级取最旧）
  - `formatDataAge(savedAt: number, now?: number): string`
  - `sourceLabel(meta: DataMeta, now?: number): string`

- [ ] **Step 1: 写失败测试 `tests/data-meta.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/data-meta.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/services/data-meta.ts`**

```ts
import type { DataSource } from './map-cache'

export interface DataMeta {
  source: DataSource
  savedAt: number
}

const SOURCE_RANK: Record<DataSource, number> = {
  network: 0,
  disk: 1,
  snapshot: 2,
  'disk-stale': 3,
}

export const summarizeResources = (resources: DataMeta[]): DataMeta | null => {
  if (resources.length === 0) return null
  return resources.reduce((worst, item) => {
    if (SOURCE_RANK[item.source] > SOURCE_RANK[worst.source]) return item
    if (
      SOURCE_RANK[item.source] === SOURCE_RANK[worst.source]
      && item.savedAt < worst.savedAt
    ) return item
    return worst
  })
}

export const formatDataAge = (savedAt: number, now = Date.now()): string => {
  const diff = Math.max(0, now - savedAt)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  return `${Math.floor(diff / day)} 天前`
}

export const sourceLabel = (meta: DataMeta, now = Date.now()): string => {
  switch (meta.source) {
    case 'network':
      return `KCNav 实时 · ${formatDataAge(meta.savedAt, now)}`
    case 'disk':
      return `本地缓存 · ${formatDataAge(meta.savedAt, now)}`
    case 'disk-stale':
      return `过期缓存 · ${formatDataAge(meta.savedAt, now)}`
    case 'snapshot':
      return `内置快照（${new Date(meta.savedAt).toISOString().slice(0, 10)}）`
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/data-meta.test.ts`
Expected: PASS

- [ ] **Step 5: 验证门**

Run: `npm run check`
Expected: 全绿

---

### Task 5: 视图集成（状态 Tag、试探/刷新按钮、数据年龄、3s 防抖、错误文案）

**Files:**
- Modify: `src/views/index.tsx`
- Modify: `src/services/kcnav.ts`（删除 Task 3 的临时兼容导出 fetchMap/fetchEnemyComps/fetchRouteEntries）

**Interfaces:**
- Consumes: Task 2 `kcnavTransport`（getStatus/subscribe/probe）、`KcnavStatus`；Task 3 `loadMap`/`loadEnemyComps`/`loadRouteEvidence`；Task 4 `summarizeResources`/`sourceLabel`、`DataMeta`
- Produces: 无（终端消费者）

无组件测试基建，本任务以 `npm run check` + Task 6 的 poi 实机验证为准。改动点逐项列出：

- [ ] **Step 1: 更新 imports 与状态**

`src/views/index.tsx` 顶部：

```tsx
import { KCNAV_BASE_URL, NODE_TYPE, PLUGIN_KEY } from '../constants'
import { sourceLabel, summarizeResources } from '../services/data-meta'
import { loadEnemyComps, loadMap, loadRouteEvidence } from '../services/kcnav'
import { kcnavTransport } from '../services/kcnav-transport'
import type { DataMeta } from '../services/data-meta'
import type { KcnavStatus } from '../services/kcnav-transport'
```

（删除原 `fetchEnemyComps, fetchMap, fetchRouteEntries` 的 import。）

组件内新增状态：

```tsx
const [kcnav, setKcnav] = useState<KcnavStatus>(kcnavTransport.getStatus())
const [mapMeta, setMapMeta] = useState<DataMeta | null>(null)
const [enemyMeta, setEnemyMeta] = useState<DataMeta[]>([])
const [refreshing, setRefreshing] = useState(false)

useEffect(() => kcnavTransport.subscribe(setKcnav), [])
```

- [ ] **Step 2: 地图加载改用 loadMap 并记录元数据**

原 `fetchMap(mapId).then((data) => …)` 的 effect 中改为：

```tsx
void loadMap(mapId)
  .then((loaded) => {
    if (disposed) return
    setMapData(loaded.value)
    setMapMeta({ source: loaded.source, savedAt: loaded.savedAt })
    const options = getTargetOptions(loaded.value)
    setTarget((current) =>
      options.some((option) => option.to === current)
        ? current
        : (options[0]?.to ?? ''),
    )
  })
```

- [ ] **Step 3: runAnalysis 改用 loadEnemyComps 并区分触发来源**

`runAnalysis` 签名改为 `useCallback(async (trigger: 'manual' | 'auto' = 'manual') => …)`；内部：

```tsx
const priority = trigger === 'manual' ? 'interactive' as const : 'background' as const
const enemyResults = await Promise.allSettled(
  battleEdges.map((edge) => loadEnemyComps(mapId, edge.id, { priority })),
)
```

成功分支中（enemyPayloads 处）同步收集元数据并删除原「emptyIndex」空数据检查（loadEnemyComps 空数据现在直接 reject，走 failedNodes 分支）：

```tsx
const enemyLoaded = enemyResults.map((result) => {
  if (result.status === 'rejected') throw result.reason
  return result.value
})
setEnemyMeta(enemyLoaded.map((item) => ({ source: item.source, savedAt: item.savedAt })))
const enemyPayloads = enemyLoaded.map((item) => item.value)
```

失败文案改为：

```tsx
throw new Error(
  `本地缓存暂缺 ${failedNodes.join('、')} 点敌编成；可点「刷新本图数据」重试，或等待 KCNav 冷却结束`,
)
```

自动触发 effect 中 `void runRef.current()` 改为 `void runRef.current('auto')`；「分析当前路线」按钮 onClick 改为 `() => void runAnalysis('manual')`。

- [ ] **Step 4: 带路核验改用 loadRouteEvidence，防抖 3 秒**

核验 effect 中 `setTimeout(…, 450)` 改为 `setTimeout(…, 3000)`，请求改为：

```tsx
void loadRouteEvidence(mapId, effectiveRoute, routingFeatures)
  .then((payload) => {
    if (generation !== evidenceGeneration.current) return
    const entries = payload.value.result?.entries ?? []
    setRouteEvidence({
      state: entries.length ? 'supported' : 'unknown',
      matchedEntries: entries.length,
      pageCount: payload.value.result?.pageCount,
      detail: entries.length
        ? 'KCNav 中存在同舰种构成、同电探/桶数量且走完这条路线的记录。'
        : 'KCNav 暂未返回符合当前编成特征的完整路线记录；这不等于一定会沟。',
    })
  })
```

（catch 分支保持原样。组件仅在插件面板挂载时存在，挂载即可见，无需额外 visibility 判断。）

- [ ] **Step 5: 刷新按钮处理函数**

```tsx
const refreshMapData = useCallback(async (): Promise<void> => {
  if (!/^\d+-\d+$/.test(mapId)) return
  setRefreshing(true)
  setError(null)
  try {
    const loaded = await loadMap(mapId, { force: true, priority: 'interactive' })
    setMapData(loaded.value)
    setMapMeta({ source: loaded.source, savedAt: loaded.savedAt })
    for (const edge of getBattleEdges(loaded.value, effectiveRoute)) {
      await loadEnemyComps(mapId, edge.id, { force: true, priority: 'interactive' })
    }
    await runRef.current('manual')
  } catch (cause) {
    setError(`刷新失败：${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    setRefreshing(false)
  }
}, [effectiveRoute, mapId])
```

- [ ] **Step 6: 状态行 JSX**

将原 `<Tag intent="none">KCNav：按当前路线读取并本地缓存</Tag>` 替换为：

```tsx
<Tag
  intent={kcnav.state === 'cooldown' ? 'danger' : kcnav.state === 'offline' ? 'none' : 'success'}
>
  {kcnav.state === 'cooldown'
    ? `KCNav 冷却中 · 剩余 ${Math.max(1, Math.ceil((kcnav.cooldownUntil - Date.now()) / 3600000))} 小时`
    : kcnav.state === 'offline'
      ? 'KCNav 离线 · 使用本地数据'
      : 'KCNav 正常'}
</Tag>
{kcnav.state === 'cooldown' && (
  <Button
    small
    onClick={() => void kcnavTransport.probe(`${KCNAV_BASE_URL}/maps/1-1`)}
  >
    试探一次
  </Button>
)}
{(() => {
  const meta = summarizeResources([...(mapMeta ? [mapMeta] : []), ...enemyMeta])
  return meta
    ? <span className="sortie-odds__muted">敌编成数据：{sourceLabel(meta)}</span>
    : null
})()}
```

- [ ] **Step 7: 控制行加刷新按钮**

「分析当前路线」按钮之后、采样数选择之前插入：

```tsx
<Button
  icon="refresh"
  loading={refreshing}
  disabled={!mapData || kcnav.state === 'cooldown' || running}
  onClick={() => void refreshMapData()}
>
  刷新本图数据
</Button>
```

- [ ] **Step 8: 底部说明 Callout 更新**

末尾 Callout 文本替换为：

```
v0.4 起 KCNav 请求全程串行节流；收到自动化拒绝会自动熔断并只用本地数据，可用「试探一次」恢复。
通常图与活动图的数据都会保存本地缓存（活动图敌编成 12 小时、地图 24 小时后自动刷新）。
打完的节点会从后续模拟中移除，并优先采用未卜先知推演出的战后 HP。
支援舰队、基地航空队、友军、活动特效与漩涡消耗尚未接入，当前结果仍是基线估计。
```

- [ ] **Step 9: 删除 kcnav.ts 的临时兼容导出**

删除 `fetchMap` / `fetchEnemyComps` / `fetchRouteEntries` 三个函数及其注释。

- [ ] **Step 10: 验证门**

Run: `npm run check`
Expected: 全绿（若 lint 报 hooks 依赖项缺失，按提示补齐 useCallback/useEffect 依赖数组）

---

### Task 6: v0.4.0 发布与实机验证

**Files:**
- Modify: `package.json`（version → 0.4.0）
- Modify: `README.md`（行为说明更新）
- 部署目标: `%APPDATA%\poi\plugins-extra\node_modules\poi-plugin-sortie-odds\`

**Interfaces:**
- Consumes: Task 1-5 全部成果
- Produces: `poi-plugin-sortie-odds-0.4.0.tgz`；已更新的 poi 本地安装

- [ ] **Step 1: 版本号与 README**

`package.json` 的 `version` 改为 `0.4.0`（`PLUGIN_UA` 在 Task 1 已写为 0.4.0，确认一致）。README「v0.3 行为」章节标题改为「v0.4 行为」，并在列表末尾追加：

```
11. 所有 KCNav 请求经全局串行队列（1.5~3 秒随机间隔）；收到自动化拒绝自动熔断 6/12/24 小时并持久化，期间只用本地数据。
12. 活动图数据也保存本地缓存（地图 24 小时、敌编成 12 小时）；带路核验结果按「地图+路线+编成特征」缓存。
```

- [ ] **Step 2: 全量验证与打包**

Run: `npm run check && npm pack`
Expected: 全绿；生成 `poi-plugin-sortie-odds-0.4.0.tgz`

- [ ] **Step 3: 部署到 poi**

```powershell
$dst = "$env:APPDATA\poi\plugins-extra\node_modules\poi-plugin-sortie-odds"
Copy-Item index.js, index.js.map, package.json -Destination $dst -Force
```

（engine/ 本次未改动，无需复制。）

- [ ] **Step 4: 请用户实机验证（重启 poi 后）**

验证清单交给用户：
1. 插件加载正常，状态行出现「KCNav 正常」绿 Tag 与数据来源小字。
2. 打开 1-5：应显示「本地缓存 · N 天前」，且完全无网络请求（可断网验证）。
3. 输入一个新海域（如 3-2）点分析：请求逐个串行发出（间隔肉眼可感知），完成后再次分析不再请求。
4. 点「刷新本图数据」：重新拉取并更新年龄显示。
5. 出击一次通常图，确认自动跟随与结算联动行为与 v0.3.4 一致。

---

### Task 7: 快照抓取脚本（v0.4.1）

**Files:**
- Create: `scripts/build-map-snapshot.ts`
- Create: `data/normal-maps/`（脚本输出，36 图）

**Interfaces:**
- Consumes: 无（独立脚本，node 内置 fetch）
- Produces: `data/normal-maps/<mapId>/map.json`、`enemy-<edgeId>.json`（`{ savedAt, value }` 包装，与磁盘缓存同构）、`data/normal-maps/manifest.json`（`{ generatedAt: number, maps: string[] }`）

- [ ] **Step 1: 实现 `scripts/build-map-snapshot.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://tsunkit.net/api/routing'
const UA = 'poi-plugin-sortie-odds/0.4.1 snapshot-builder (one-off, throttled 3s)'
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'data', 'normal-maps')
const ENEMY_NODE_TYPES = new Set([4, 5, 7, 10, 11, 13, 15, -1])

const WORLDS: Record<string, number> = { '1': 6, '2': 5, '3': 5, '4': 5, '5': 5, '6': 5, '7': 5 }
const MAPS = Object.entries(WORLDS).flatMap(([world, count]) =>
  Array.from({ length: count }, (_, index) => `${world}-${index + 1}`))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const throttle = (): Promise<void> => sleep(3000 + Math.random() * 1000)

const fetchJson = async (url: string): Promise<any> => {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } })
  const text = await response.text()
  if (response.status === 401 && /automation/i.test(text)) {
    throw new Error(`KCNav 拒绝了自动化请求，停止抓取：${text.slice(0, 120)}`)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 160)}`)
  return JSON.parse(text)
}

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

const main = async (): Promise<void> => {
  const only = process.argv.slice(2)
  const targets = only.length ? MAPS.filter((mapId) => only.includes(mapId)) : MAPS
  const generatedAt = Date.now()
  const done: string[] = []
  for (const mapId of targets) {
    const dir = join(OUT, mapId)
    await mkdir(dir, { recursive: true })
    const map = await fetchJson(`${BASE}/maps/${mapId}`)
    await writeFile(join(dir, 'map.json'), JSON.stringify({ savedAt: generatedAt, value: map }))
    await throttle()
    const edges = Object.entries(map.result.route as Record<string, [string | null, string, number, number]>)
      .filter(([id, value]) => id !== '0' && value[0] != null && ENEMY_NODE_TYPES.has(value[2]))
    for (const [edgeId] of edges) {
      const params = new URLSearchParams({ start: isoDaysAgo(180), compsLimit: '100' })
      const enemy = await fetchJson(`${BASE}/maps/${mapId}/edges/${edgeId}/enemycomps?${params}`)
      if (enemy.result?.entries?.length) {
        await writeFile(
          join(dir, `enemy-${edgeId}.json`),
          JSON.stringify({ savedAt: generatedAt, value: enemy }),
        )
      }
      await throttle()
    }
    done.push(mapId)
    console.log(`done ${mapId} (${edges.length} battle edges)`)
  }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ generatedAt, maps: done }, null, 2))
  console.log(`snapshot complete: ${done.length} maps`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
```

（脚本不进 tsdown 构建、不受 eslint src 范围约束；`any` 仅限脚本内使用。若 eslint 配置覆盖 scripts 目录导致 `npm run check` 报错，在 `eslint.config.mjs` 的 ignores 中加入 `'scripts/**'`。）

- [ ] **Step 2: 单图冒烟**

Run: `npx tsx scripts/build-map-snapshot.ts 1-1`
Expected: 输出 `done 1-1 (3 battle edges)` 左右，`data/normal-maps/1-1/` 生成 map.json 与若干 enemy-*.json，`manifest.json` 的 maps 为 `["1-1"]`

- [ ] **Step 3: 全量抓取（后台运行约 20~25 分钟）**

Run: `npx tsx scripts/build-map-snapshot.ts`（后台执行）
Expected: 36 图全部 `done`；若中途 401 → 脚本立刻终止，**不要重试**，改天再跑或用已完成部分

- [ ] **Step 4: 产物检查**

Run: `Get-ChildItem data/normal-maps -Recurse -File | Measure-Object -Property Length -Sum`
Expected: 文件总大小 2~4MB 量级；36 个子目录；manifest.json 的 maps 长度 36

---

### Task 8: 快照接线、v0.4.1 发布与验证

**Files:**
- Modify: `src/services/map-cache.ts`（新增 manifest 读取）
- Modify: `src/views/index.tsx`（显示内置数据日期）
- Modify: `package.json`（files 加 `data`，version → 0.4.1）
- Modify: `src/constants.ts`（PLUGIN_UA → 0.4.1）
- Modify: `tests/map-cache.test.ts`（manifest 用例）
- 部署目标: 同 Task 6

**Interfaces:**
- Consumes: Task 7 的 `data/normal-maps/`；Task 1 的 MapCache
- Produces: `readSnapshotManifest(): Promise<{ generatedAt: number; maps: string[] } | null>`（map-cache 新增导出，从 `<snapshotRoot>/manifest.json` 读取）

- [ ] **Step 1: 写失败测试（追加到 `tests/map-cache.test.ts`）**

```ts
it('readSnapshotManifest 读取生成日期', async () => {
  const roots = await makeRoots()
  await mkdir(roots.snapshotRoot, { recursive: true })
  await writeFile(
    join(roots.snapshotRoot, 'manifest.json'),
    JSON.stringify({ generatedAt: 1752624000000, maps: ['1-1'] }),
    'utf8',
  )
  const cache = createMapCache(roots)
  expect(await cache.readSnapshotManifest()).toMatchObject({
    generatedAt: 1752624000000,
    maps: ['1-1'],
  })
  expect(await createMapCache({ ...roots, snapshotRoot: null }).readSnapshotManifest()).toBeNull()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/map-cache.test.ts`
Expected: FAIL —— `readSnapshotManifest` 不存在

- [ ] **Step 3: 实现 manifest 读取**

`MapCache` 接口增加 `readSnapshotManifest: () => Promise<{ generatedAt: number; maps: string[] } | null>`，`createMapCache` 返回对象中新增：

```ts
readSnapshotManifest: async () => {
  if (!snapshotRoot) return null
  try {
    const raw = JSON.parse(
      await readFile(join(snapshotRoot, 'manifest.json'), 'utf8'),
    ) as { generatedAt?: number; maps?: string[] }
    if (typeof raw.generatedAt !== 'number') return null
    return { generatedAt: raw.generatedAt, maps: raw.maps ?? [] }
  } catch {
    return null
  }
},
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/map-cache.test.ts`
Expected: PASS

- [ ] **Step 5: 视图显示内置数据日期**

`src/views/index.tsx`：

```tsx
import { mapCache } from '../services/map-cache'

const [snapshotDate, setSnapshotDate] = useState<string | null>(null)
useEffect(() => {
  void mapCache.readSnapshotManifest().then((manifest) => {
    if (manifest) setSnapshotDate(new Date(manifest.generatedAt).toISOString().slice(0, 10))
  })
}, [])
```

状态行（Task 5 Step 6 的数据来源小字之后）追加：

```tsx
{snapshotDate && (
  <span className="sortie-odds__muted">内置数据：{snapshotDate}</span>
)}
```

- [ ] **Step 6: 打包配置与版本**

`package.json`：`version` → `0.4.1`；`files` 数组加入 `"data"`。`src/constants.ts`：`PLUGIN_UA` → `'poi-plugin-sortie-odds/0.4.1'`。

- [ ] **Step 7: 验证门与打包**

Run: `npm run check && npm pack`
Expected: 全绿；`poi-plugin-sortie-odds-0.4.1.tgz` 生成且体积比 0.4.0 大 2~4MB

- [ ] **Step 8: 部署**

```powershell
$dst = "$env:APPDATA\poi\plugins-extra\node_modules\poi-plugin-sortie-odds"
Copy-Item index.js, index.js.map, package.json -Destination $dst -Force
Copy-Item data -Destination $dst -Recurse -Force
```

- [ ] **Step 9: 请用户实机验证（重启 poi 后）**

1. 状态行出现「内置数据：YYYY-MM-DD」。
2. 删除 `%APPDATA%\poi\sortie-odds-cache\maps-v2`（模拟全新用户）后断网，任意通常图（如 4-2）分析可直接出结果，来源显示「内置快照」。
3. 「刷新本图数据」联网后仍可强制更新并把来源变为「KCNav 实时」。

---

## Self-Review 记录

- **Spec 覆盖**：串行队列/优先级（Task 2）、401 熔断+持久化+试探翻倍（Task 2）、核验收敛：磁盘缓存+3s 防抖+面板可见（Task 3/5）、maps-v2+TTL 分档+v1 迁移（Task 1）、快照+解析顺序（Task 1/3/7/8）、UI 三态/年龄/刷新（Task 5/8）、README（Task 6）——全部有对应任务。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`CachedResource`/`DataSource`/`KcnavStatus`/`LoadOptions` 等签名在 Interfaces 块与代码块中逐一核对一致；`summarizeResources` 的 DataMeta 与 CachedResource 字段兼容（结构子集）。
- **已知取舍**：视图层无组件测试基建，Task 5 依赖 check + 实机验证；快照抓取脚本属一次性开发工具，不纳入单测。
