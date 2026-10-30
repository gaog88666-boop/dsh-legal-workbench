/**
 * 邮件规则库的解析与重写。
 *
 * 文件是 `references/style-rules.md`：`### R-xxx · 标题` + 五个字段，分在
 * 「## 硬规则 / ## 软规则 / ## 待观察」三段。其余部分（开头说明、计数表、
 * 生命周期、规则格式、已废弃、维护约定）必须原样保留。
 *
 * 设计原则：**先证明能无损往返**。parse → render 必须与原文件逐字节一致，
 * 否则任何编辑都可能悄悄改坏这份给 agent 用的规则库。
 */

const SECTIONS = [
  { key: 'hard', heading: '硬规则' },
  { key: 'soft', heading: '软规则' },
  { key: 'watch', heading: '待观察' },
]

const FIELD_ORDER = ['规则', '证据', '来源', '强度', '反例']

/** 把一段 markdown 拆成「段落块」：每个 H2 及其后正文。 */
function splitSections(markdown) {
  const lines = markdown.split('\n')
  const blocks = []
  let current = { heading: null, lines: [] }
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      blocks.push(current)
      current = { heading: line, lines: [] }
      continue
    }
    current.lines.push(line)
  }
  blocks.push(current)
  return blocks
}

function parseRuleBlock(lines) {
  const text = lines.join('\n').trim()
  if (text === '') return null
  const headingMatch = /^###\s+(R-\d+)\s*[·:：-]?\s*(.*)$/.exec(lines[0] ?? '')
  if (headingMatch === null) return null
  const item = { id: headingMatch[1], title: headingMatch[2].trim(), fields: {} }
  for (const field of FIELD_ORDER) item.fields[field] = ''
  // 超长字段（规则/反例）可能是多行，一直收集到下一个 `- xxx：` 为止
  let currentField = null
  for (const line of lines.slice(1)) {
    const fieldMatch = /^-\s*([^：:]{1,6})[：:]\s*(.*)$/.exec(line)
    if (fieldMatch !== null && FIELD_ORDER.includes(fieldMatch[1].trim())) {
      currentField = fieldMatch[1].trim()
      item.fields[currentField] = fieldMatch[2]
      continue
    }
    if (currentField !== null && line.trim() !== '') {
      item.fields[currentField] = item.fields[currentField] === '' ? line.trim() : item.fields[currentField] + '\n' + line.trim()
      continue
    }
    if (line.trim() === '') continue
    item.fields[currentField ?? '规则'] = (item.fields[currentField ?? '规则'] ?? '') + (currentField ? '\n' : '') + line.trim()
  }
  return item
}

/** 解析整份规则库。返回结构与原文块，便于无损回写。 */
export function parseRules(markdown) {
  const blocks = splitSections(markdown)
  const items = []
  const structure = []

  for (const block of blocks) {
    const sectionKey = SECTIONS.find((section) => block.heading !== null && block.heading.includes(section.heading))?.key
    if (sectionKey === undefined) {
      structure.push({ kind: 'raw', heading: block.heading, lines: block.lines })
      continue
    }
    // 三段里的内容：按 `### ` 切条目，条目外的行（如「（空）」）单独保留
    const entries = []
    let current = null
    for (const line of block.lines) {
      if (/^###\s+/.test(line)) {
        if (current !== null) entries.push(current)
        current = [line]
        continue
      }
      if (current === null) entries.push({ raw: line })
      else current.push(line)
    }
    if (current !== null) entries.push(current)

    /** 把条目尾部的空行数出来单独保存：写回时要原样补上，否则空行会丢。 */
    const splitTrailingBlanks = (lines) => {
      let end = lines.length
      while (end > 0 && lines[end - 1].trim() === '') end -= 1
      return { body: lines.slice(0, end), blanks: lines.length - end }
    }

    const parsed = []
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        const { body, blanks } = splitTrailingBlanks(entry)
        const item = parseRuleBlock(body)
        if (item !== null) {
          item.section = sectionKey
          parsed.push({ kind: 'rule', item, blanks })
          items.push(item)
          continue
        }
        parsed.push({ kind: 'raw', lines: entry })
      } else {
        parsed.push({ kind: 'raw', lines: [entry.raw] })
      }
    }
    structure.push({ kind: 'section', key: sectionKey, heading: block.heading, entries: parsed })
  }

  return { structure, items }
}

function renderRuleBlock(item) {
  const lines = [`### ${item.id} · ${item.title}`]
  for (const field of FIELD_ORDER) {
    const value = String(item.fields?.[field] ?? '').trim()
    lines.push(`- ${field}：${value}`)
  }
  return lines
}

/** 按结构写回整份 markdown。未改动的部分逐字节还原。 */
export function renderRules(document) {
  const out = []
  for (const block of document.structure) {
    if (block.kind === 'raw') {
      if (block.heading !== null) out.push(block.heading)
      out.push(...block.lines)
      continue
    }
    out.push(block.heading)
    for (const entry of block.entries) {
      if (entry.kind === 'raw') {
        out.push(...entry.lines)
        continue
      }
      out.push(...renderRuleBlock(entry.item))
      for (let index = 0; index < (entry.blanks ?? 0); index += 1) out.push('')
    }
  }
  return out.join('\n')
}

/** 直接把 items 数组同步回结构（新增/删除/编辑后调用）。 */
export function applyItems(document, items) {
  for (const block of document.structure) {
    if (block.kind !== 'section') continue
    const kept = items.filter((item) => item.section === block.key)
    const existing = new Map()
    for (const entry of block.entries) {
      if (entry.kind === 'rule') existing.set(entry.item.id, entry.item)
    }
    const rawEntries = block.entries.filter((entry) => entry.kind === 'raw')
    block.entries = [
      ...kept.map((item) => ({ kind: 'rule', item })),
      ...rawEntries,
    ]
  }
  return document
}

/** 重算「计数」表里的三项（硬/软/待观察）与最后整合时间。 */
export function refreshCounts(document, items, stamp) {
  const counts = { hard: 0, soft: 0, watch: 0 }
  for (const item of items) counts[item.section] = (counts[item.section] ?? 0) + 1
  for (const block of document.structure) {
    if (block.kind !== 'raw') continue
    block.lines = block.lines.map((line) => {
      if (!line.trim().startsWith('|')) return line
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
      if (cells.length < 2) return line
      const [label] = cells
      if (label.includes('硬规则数')) return `| ${label} | ${counts.hard} |`
      if (label.includes('软规则数')) return `| ${label} | ${counts.soft} |`
      if (label.includes('待观察')) return `| ${label} | ${counts.watch} |`
      if (label.includes('最后整合') && stamp !== undefined) return `| ${label} | ${stamp} |`
      return line
    })
  }
  return document
}
