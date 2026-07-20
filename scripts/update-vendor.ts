import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const REPO = 'KC3Kai/kancolle-replay'
const RAW = `https://raw.githubusercontent.com/${REPO}/master`

// 本地相对仓库根的路径 → 上游路径
const FILES: Array<[string, string]> = [
  ['engine/vendor/kcSHIPDATA.js', 'js/kcSHIPDATA.js'],
  ['engine/vendor/kcEQDATA.js', 'js/kcEQDATA.js'],
  ['engine/vendor/shared.js', 'js/shared.js'],
  ['engine/vendor/kcships.js', 'js/kcships.js'],
  ['engine/vendor/kcsim.js', 'js/kcsim.js'],
  ['engine/vendor/kcsimcombined.js', 'js/kcsimcombined.js'],
  ['engine/vendor/common.js', 'js/simulator-ui/common.js'],
  ['engine/vendor/sim-interface.js', 'js/simulator-ui/sim-interface.js'],
  ['engine/js/data/country_ctype.json', 'js/data/country_ctype.json'],
  ['engine/js/data/mst_slotitem_bonus.json', 'js/data/mst_slotitem_bonus.json'],
  ['engine/js/data/shell_range_weights.json', 'js/data/shell_range_weights.json'],
]

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'poi-plugin-sortie-odds vendor updater' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.text()
}

const main = async (): Promise<void> => {
  const commitInfo = JSON.parse(
    await fetchText(`https://api.github.com/repos/${REPO}/commits/master`),
  ) as { sha: string }
  console.log(`upstream master: ${commitInfo.sha}`)

  for (const [local, remote] of FILES) {
    const text = await fetchText(`${RAW}/${remote}`)
    await writeFile(join(ROOT, local), text, 'utf8')
    console.log(`updated ${local} (${text.length} bytes)`)
  }

  const noticesPath = join(ROOT, 'THIRD_PARTY_NOTICES.md')
  const notices = await readFile(noticesPath, 'utf8')
  await writeFile(
    noticesPath,
    notices.replace(/Vendored commit: `[0-9a-f]+`/, `Vendored commit: \`${commitInfo.sha}\``),
    'utf8',
  )
  console.log('THIRD_PARTY_NOTICES.md updated')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
