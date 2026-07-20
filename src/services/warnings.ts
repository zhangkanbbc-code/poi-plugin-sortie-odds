import type { EngineWarning } from '../types'

const warningArg = (warning: EngineWarning): string => {
  const arg = warning.args?.[0]
  if (arg != null) return String(arg)
  // 兜底：从已格式化文本尾部提取编号
  const match = /-\s*(\d+)\s*$/.exec(warning.txt ?? '')
  return match?.[1] ?? ''
}

// 把模拟器逐条重复的英文警告合并成少量中文摘要
export const summarizeEngineWarnings = (warnings: EngineWarning[]): string[] => {
  const unknownStats = new Set<string>()
  const unknownShips = new Set<string>()
  const unknownEquips = new Set<string>()
  const others = new Map<string, number>()

  for (const warning of warnings) {
    switch (warning.key) {
      case 'warn_ship_unknownstats': {
        const id = warningArg(warning)
        if (id) unknownStats.add(id)
        break
      }
      case 'warn_unknown_ship': {
        const id = warningArg(warning)
        if (id) unknownShips.add(id)
        break
      }
      case 'warn_unknown_equip':
      case 'warn_unknown_equiptype': {
        const id = warningArg(warning)
        if (id) unknownEquips.add(id)
        break
      }
      default: {
        const text = warning.txt ?? warning.key ?? '未知提示'
        others.set(text, (others.get(text) ?? 0) + 1)
      }
    }
  }

  const lines: string[] = []
  if (unknownStats.size > 0) {
    lines.push(
      `深海舰 ${[...unknownStats].join('、')} 的精确属性未公开（回避/运等为社区推测值），`
      + '胜率仍以 KCNav 实测的 HP/火力/装甲计算，结果可能略偏乐观',
    )
  }
  if (unknownShips.size > 0) {
    lines.push(`舰船 ${[...unknownShips].join('、')} 图鉴数据缺失，特殊效果可能未计入`)
  }
  if (unknownEquips.size > 0) {
    lines.push(`装备 ${[...unknownEquips].join('、')} 图鉴数据缺失，特殊效果可能未计入`)
  }
  for (const [text, count] of others) {
    lines.push(count > 1 ? `${text} ×${count}` : text)
  }
  return lines
}
