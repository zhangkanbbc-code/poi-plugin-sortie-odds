import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

const readManifest = async (): Promise<{ generatedAt: number; maps: string[] }> => {
  try {
    const raw = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8'))
    return { generatedAt: Number(raw.generatedAt) || Date.now(), maps: raw.maps ?? [] }
  } catch {
    return { generatedAt: Date.now(), maps: [] }
  }
}

const main = async (): Promise<void> => {
  const only = process.argv.slice(2)
  const manifest = await readManifest()
  const done = new Set(manifest.maps)
  const targets = (only.length ? MAPS.filter((mapId) => only.includes(mapId)) : MAPS)
    .filter((mapId) => !done.has(mapId))
  if (targets.length === 0) {
    console.log('snapshot already complete')
    return
  }
  console.log(`resume: ${done.size} maps already done, ${targets.length} to go`)
  const generatedAt = Date.now()
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
    done.add(mapId)
    // 每完成一图就落盘 manifest，中断后重跑可跳过已完成的图
    await writeFile(
      join(OUT, 'manifest.json'),
      JSON.stringify({ generatedAt, maps: [...done] }, null, 2),
    )
    console.log(`done ${mapId} (${edges.length} battle edges)`)
  }
  console.log(`snapshot complete: ${done.size} maps`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
