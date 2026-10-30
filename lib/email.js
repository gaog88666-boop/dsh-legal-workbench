/**
 * 邮件起草：只读技能目录里的规则库统计。
 *
 * 规则库是 `references/style-rules.md`：文件自己带一张「计数」表（硬/软/待观察/已吸收终稿），
 * 这里优先读那张表；表里没有的项，退回去数三个 H2 段落下的 `### R-xxx` 条目标题。
 * 只读，不写——规则库的唯一写入路径是 J 明确批准（见该文件第 3 行）。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const SECTION_MARKERS = [
  { key: 'hard', heading: '硬规则' },
  { key: 'soft', heading: '软规则' },
  { key: 'watch', heading: '待观察' },
]

/** 从「计数」表里读一个指标（标签做包含匹配，容忍措辞微调）。 */
function readCountTable(text) {
  const counts = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    if (cells.length < 2) continue
    const [label, value] = cells
    const number = Number(String(value).replace(/[^\d-]/g, ''))
    if (!Number.isFinite(number)) continue
    if (label.includes('已吸收终稿')) counts.absorbed = number
    else if (label.includes('硬规则')) counts.hard = number
    else if (label.includes('软规则')) counts.soft = number
    else if (label.includes('待观察')) counts.watch = number
  }
  return counts
}

/** 数某个 H2 段落下的 `### ` 条目数（计数表缺失时的兜底）。 */
function countSectionEntries(text, headingKeyword) {
  const lines = text.split(/\r?\n/)
  let inSection = false
  let count = 0
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inSection = line.includes(headingKeyword)
      continue
    }
    if (inSection && /^###\s+/.test(line)) count += 1
  }
  return count
}

/** 「最后整合」那一行（可能是日期或 —）。 */
function readLastMerge(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('最后整合')) {
      const cells = line.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '')
      const value = cells[cells.length - 1]
      if (value !== undefined && value !== '') return value
    }
  }
  return undefined
}

export async function readEmailStats(emailSkillDir) {
  const rulesPath = join(emailSkillDir, 'references', 'style-rules.md')
  let text
  let info
  try {
    info = await stat(rulesPath)
    text = await readFile(rulesPath, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') {
      return { ok: false, code: 'missing_rules', message: '规则库不存在：' + rulesPath, path: rulesPath }
    }
    return { ok: false, code: 'unreadable_rules', message: error instanceof Error ? error.message : String(error), path: rulesPath }
  }

  const table = readCountTable(text)
  const counted = {
    hard: countSectionEntries(text, '硬规则'),
    soft: countSectionEntries(text, '软规则'),
    watch: countSectionEntries(text, '待观察'),
  }
  return {
    ok: true,
    path: rulesPath,
    mtimeMs: Math.round(info.mtimeMs),
    size: info.size,
    absorbed: table.absorbed,
    hard: table.hard ?? counted.hard,
    soft: table.soft ?? counted.soft,
    watch: table.watch ?? counted.watch,
    lastMerge: readLastMerge(text),
    // 计数表与条目数不一致时如实报出来（不替文件圆谎）。
    inconsistency: table.hard !== undefined && table.hard !== counted.hard
      ? '计数表写 ' + table.hard + ' 条硬规则，正文实际 ' + counted.hard + ' 条'
      : undefined,
  }
}
