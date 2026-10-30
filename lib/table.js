/**
 * 通用「一张 Markdown 表格」的解析 / 校验 / 备份 / 原子写。
 *
 * 术语表（中文｜英文｜领域｜标签｜备注）和句式库（英文句式｜中文处理｜场合｜标签｜备注）
 * 共用这套存储：列名、字段名、主键字段由 createTable 传入，写盘纪律完全一致。
 *
 * 写入纪律（这是"写盘失败不留半截文件"的唯一实现）：
 *   ① 先解析现有文件；解析不了就**拒绝写入**，原文件一个字不动；
 *   ② 现有字节复制到 `<file>.bak`（上一版永远可回滚）；
 *   ③ 新内容写同目录临时文件，再 rename 覆盖目标（rename 是原子的）；
 *   ④ 任何一步失败：删临时文件、抛错，原文件仍是旧内容。
 *
 * id = sha1(主键字段用 \0 连接).slice(0, 12)。改主键字段即换了 key，按"删了旧的、加了新的"处理。
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, unlink, copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const SEPARATOR = /^:?-{2,}:?$/
const MAX_FIELD = 200
const ID_LENGTH = 12

/** 输入校验失败（路由层映射成 400）。 */
export class TableValidationError extends Error {
  constructor(message, code = 'invalid_table') {
    super(message)
    this.name = 'TableValidationError'
    this.code = code
  }
}

/** 一行的字段（缺列补空串）。 */
function cellsOf(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((cell) => cell.trim())
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 单字段校验：禁竖线/换行/制表符，长度上限。 */
function validateField(name, value) {
  const text = String(value ?? '').trim()
  if (text.includes('|')) throw new TableValidationError(name + ' 不能含竖线（|），会破坏表格')
  if (/[\r\n\t]/.test(text)) throw new TableValidationError(name + ' 不能含换行或制表符')
  if (text.length > MAX_FIELD) throw new TableValidationError(name + ' 超过 ' + MAX_FIELD + ' 字')
  return text
}

/**
 * 建一张表。
 * @param {object} config
 * @param {string[]} config.header  表头文字（写盘用）
 * @param {string[]} config.keys    字段名，与 header 一一对应
 * @param {string[]} config.idKeys  组成 id 的字段
 * @param {{index:number}} [config.legacy]  老版本少一列时，在该下标补空串
 * @param {string} [config.heading]  文件首行标题
 * @param {string} [config.intro]    标题下的说明段
 * @param {string} [config.label]    报错里显示的字段名（如"英文句式"）
 */
export function createTable(config) {
  const { header, keys, idKeys, legacy = null, heading = '', intro = '', label = '' } = config
  if (!Array.isArray(header) || !Array.isArray(keys) || header.length !== keys.length) {
    throw new Error('createTable：header 与 keys 必须等长')
  }
  const labelOf = (key) => header[keys.indexOf(key)] ?? key
  const prefix = label === '' ? '' : label + ' '

  function idOf(values) {
    const source = idKeys.map((key) => String(values?.[key] ?? '')).join('\u0000')
    return createHash('sha1').update(source).digest('hex').slice(0, ID_LENGTH)
  }

  /** 解析 Markdown 表格 → 条目数组。解析不出任何条目也不算失败（新建空表）。 */
  function parse(text) {
    const entries = []
    const seen = new Set()
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const cells = cellsOf(line)
      if (cells === null || cells.length === 0) continue
      if (cells.every((cell) => SEPARATOR.test(cell))) continue
      if (cells[0] === header[0] && cells[1] === header[1]) continue
      const row = cells.slice(0, header.length)
      while (row.length < header.length) row.push('')
      if (legacy !== null && cells.length === header.length - 1) {
        row.splice(legacy.index, 0, '')
      }
      const entry = {}
      keys.forEach((key, index) => { entry[key] = row[index] ?? '' })
      if (idKeys.every((key) => entry[key] === '')) continue
      const id = idOf(entry)
      if (seen.has(id)) continue
      seen.add(id)
      entries.push({ id, ...entry })
    }
    return entries
  }

  /** 条目数组 → Markdown 全文（唯一的序列化口径）。 */
  function serialize(entries) {
    const lines = []
    if (heading !== '') lines.push(heading, '')
    if (intro !== '') lines.push(intro, '')
    lines.push('| ' + header.join(' | ') + ' |')
    lines.push('| ' + header.map(() => '---').join(' | ') + ' |')
    for (const entry of entries) {
      lines.push('| ' + keys.map((key) => String(entry?.[key] ?? '')).join(' | ') + ' |')
    }
    lines.push('')
    return lines.join('\n')
  }

  /** 新增/修改都走这里：归一 + 主键字段不能全空。 */
  function normalize(input, { selfId = null } = {}) {
    const value = {}
    for (const key of keys) value[key] = validateField(prefix + labelOf(key), input?.[key])
    if (idKeys.every((key) => value[key] === '')) {
      throw new TableValidationError(prefix + idKeys.map(labelOf).join('和') + '至少要填一个')
    }
    return { id: idOf(value), ...value, selfId }
  }

  /** 读文件：不存在返回空表 + exists:false；读失败不报错，带 warning。 */
  async function read(file) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') return { entries: [], exists: false }
      return { entries: [], exists: false, warning: '读取失败：' + describe(error) }
    }
    return { entries: parse(text), exists: true }
  }

  /** 原子写：备份 → 临时文件 → rename。 */
  async function writeEntries(file, entries) {
    const next = serialize(entries)
    try {
      await mkdir(dirname(file), { recursive: true })
    } catch (error) {
      return { ok: false, error: '目录不可写：' + describe(error), code: 'write_failed' }
    }
    try {
      await copyFile(file, file + '.bak')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') {
        return { ok: false, error: '备份失败，已放弃写入（原文件未改动）：' + describe(error), code: 'backup_failed' }
      }
    }
    const temp = file + '.tmp-' + process.pid
    try {
      await writeFile(temp, next, 'utf8')
      await rename(temp, file)
    } catch (error) {
      try { await unlink(temp) } catch { /* 临时文件可能根本没创建成功 */ }
      return { ok: false, error: '写入失败，原文件未改动：' + describe(error), code: 'write_failed' }
    }
    return { ok: true, entries }
  }

  async function add(file, input) {
    const current = await read(file)
    if (current.warning !== undefined) return { ok: false, error: current.warning, code: 'read_failed' }
    let normalized
    try {
      normalized = normalize(input)
    } catch (error) {
      if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
      throw error
    }
    if (current.entries.some((entry) => entry.id === normalized.id)) {
      return { ok: false, error: '已经有同一条（主键相同）', code: 'duplicate' }
    }
    const { selfId, ...fields } = normalized
    const entry = { id: normalized.id, ...fields }
    const written = await writeEntries(file, [...current.entries, entry])
    return written.ok === true ? { ok: true, entry, entries: written.entries } : written
  }

  async function update(file, id, input) {
    const current = await read(file)
    if (current.warning !== undefined) return { ok: false, error: current.warning, code: 'read_failed' }
    const index = current.entries.findIndex((entry) => entry.id === id)
    if (index < 0) return { ok: false, error: '找不到这条（可能已被删除或改过）', code: 'not_found' }
    let normalized
    try {
      normalized = normalize(input)
    } catch (error) {
      if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
      throw error
    }
    const collision = current.entries.some((entry, position) => position !== index && entry.id === normalized.id)
    if (collision) return { ok: false, error: '改完之后与另一条完全相同', code: 'duplicate' }
    const { selfId, ...fields } = normalized
    const entry = { id: normalized.id, ...fields }
    const entries = current.entries.slice()
    entries[index] = entry
    const written = await writeEntries(file, entries)
    return written.ok === true ? { ok: true, entry, entries: written.entries } : written
  }

  async function remove(file, id) {
    const current = await read(file)
    if (current.warning !== undefined) return { ok: false, error: current.warning, code: 'read_failed' }
    if (!current.entries.some((entry) => entry.id === id)) {
      return { ok: false, error: '找不到这条（可能已被删除）', code: 'not_found' }
    }
    const entries = current.entries.filter((entry) => entry.id !== id)
    const written = await writeEntries(file, entries)
    return written.ok === true ? { ok: true, entries } : written
  }

  return { header, keys, idOf, parse, serialize, normalize, read, add, update, remove }
}
