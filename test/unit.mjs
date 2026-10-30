/**
 * 纯逻辑单测：cards / prompts / glossary / email / vault。
 * 全部用临时目录，不碰真实数据。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readCards, BUILTIN_CARDS } from '../lib/cards.js'
import { readPrompts } from '../lib/prompts.js'
import * as G from '../lib/glossary.js'
import { readEmailStats } from '../lib/email.js'
import { createVaultStore, previewOf, sectionsOf } from '../lib/vault.js'
import { createReporter, tempDir } from './helpers.mjs'

const { check, report } = createReporter('unit')
const tmp = await tempDir()

try {
  /* ---------------------------------------------------------------- cards */
  await writeFile(join(tmp.dir, 'cards.json'), JSON.stringify({
    cards: [
      { id: 'a', kind: 'sop', title: 'A', order: 20 },
      { id: 'b', kind: 'prompt', title: 'B', order: 10, promptId: 'p1' },
      { id: 'c', kind: 'weird', title: 'C', order: 30, placement: 'strip' },
    ],
  }), 'utf8')
  const cards = await readCards(join(tmp.dir, 'cards.json'))
  check('cards 读文件并排序', cards.source === 'file' && cards.cards.map((c) => c.id).join(',') === 'b,a,c')
  check('cards 透出 placement', cards.cards.find((c) => c.id === 'c').placement === 'strip')

  await writeFile(join(tmp.dir, 'bad.json'), '{oops', 'utf8')
  const broken = await readCards(join(tmp.dir, 'bad.json'))
  check('cards 坏 JSON 回退内置', broken.source === 'builtin' && broken.cards.length === BUILTIN_CARDS.length && Boolean(broken.warning))

  await writeFile(join(tmp.dir, 'partial.json'), JSON.stringify({ cards: [{ id: 'a', kind: 'sop' }, { id: 'a', kind: 'x' }, {}] }), 'utf8')
  const partial = await readCards(join(tmp.dir, 'partial.json'))
  check('cards 单条坏只丢那一条', partial.cards.length === 1 && Boolean(partial.warning))

  /* -------------------------------------------------------------- prompts */
  await writeFile(join(tmp.dir, 'prompts.json'), JSON.stringify({ prompts: { p1: { title: 'T', text: 'hello' }, p2: { title: 'no text' } } }), 'utf8')
  const prompts = await readPrompts(join(tmp.dir, 'prompts.json'))
  check('prompts 丢掉没有正文的模板', prompts.source === 'file' && Object.keys(prompts.prompts).join(',') === 'p1')
  check('prompts 缺失回退内置', (await readPrompts(join(tmp.dir, 'nope.json'))).source === 'builtin')

  /* -------------------------------------------------------------- glossary */
  const glossaryFile = join(tmp.dir, '术语表.md')
  const added = await G.addGlossaryEntry(glossaryFile, { zh: '差额补足', en: 'Shortfall Undertaking', field: '增信', note: '' })
  check('glossary 新增', added.ok === true && added.entry.id.length === 12)
  check('glossary 首次写入不产生 .bak', await readFile(glossaryFile + '.bak', 'utf8').then(() => false, () => true))

  const duplicated = await G.addGlossaryEntry(glossaryFile, { zh: '差额补足', en: 'Shortfall Undertaking' })
  check('glossary 重复被拒', duplicated.ok === false && duplicated.code === 'duplicate')

  const before = await readFile(glossaryFile, 'utf8')
  const piped = await G.addGlossaryEntry(glossaryFile, { zh: 'a|b', en: 'x' })
  check('glossary 含竖线被拒且文件不变', piped.ok === false && (await readFile(glossaryFile, 'utf8')) === before)
  check('glossary 空条目被拒', (await G.addGlossaryEntry(glossaryFile, { zh: '', en: '' })).ok === false)
  check('glossary 超长被拒', (await G.addGlossaryEntry(glossaryFile, { zh: 'x'.repeat(201), en: '' })).ok === false)

  const second = await G.addGlossaryEntry(glossaryFile, { zh: '提款期', en: 'Availability Period', field: '融资' })
  const updated = await G.updateGlossaryEntry(glossaryFile, added.entry.id, { zh: '差额补足', en: 'Shortfall Undertaking Agreement', field: '增信', note: '改过' })
  check('glossary 改 key 生成新 id', updated.ok === true && updated.entry.id !== added.entry.id)
  check('glossary 改后 .bak 留住旧版', (await readFile(glossaryFile + '.bak', 'utf8')).includes('Shortfall Undertaking'))
  check('glossary 删除', (await G.deleteGlossaryEntry(glossaryFile, second.entry.id)).ok === true)
  check('glossary 解析回两条→一条', G.parseGlossary(await readFile(glossaryFile, 'utf8')).length === 1)
  const multi = await G.addGlossaryEntry(glossaryFile, { zh: '测试句式', en: 'test pattern', tag: '句式，待核，句式' })
  check('标签多值去重与规范化', multi.ok === true && multi.entry.tag === '句式, 待核', multi.entry?.tag)
  check('标签清空', (await G.updateGlossaryEntry(glossaryFile, multi.entry.id, { zh: '测试句式', en: 'test pattern', tag: '' })).entry.tag === '')


  /* ----------------------------------------------------------------- email */
  const emailDir = join(tmp.dir, 'email')
  await mkdir(join(emailDir, 'references'), { recursive: true })
  await writeFile(join(emailDir, 'references', 'style-rules.md'), [
    '| 硬规则数 | 2 |',
    '| 软规则数 | 3 |',
    '| 待观察（已批准） | 1 |',
    '| 最后整合 | 2026-10-20 |',
    '## 硬规则（≥3 次）',
    '### R-001 · a',
    '### R-002 · b',
    '## 软规则',
    '### R-003 · c',
    '## 待观察',
    '### R-004 · d',
  ].join('\n'), 'utf8')
  const stats = await readEmailStats(emailDir)
  check('email 读计数表', stats.ok === true && stats.hard === 2 && stats.soft === 3 && stats.watch === 1 && stats.lastMerge === '2026-10-20')
  check('email 缺文件报 missing_rules', (await readEmailStats(join(tmp.dir, 'none'))).code === 'missing_rules')

  /* ----------------------------------------------------------------- vault */
  const vaultRoot = join(tmp.dir, 'vault')
  await mkdir(join(vaultRoot, 'SOP', '子目录'), { recursive: true })
  await writeFile(join(vaultRoot, 'SOP', '甲.md'), '# 甲\n第一段\n\n**小节一**\n内容一\n', 'utf8')
  await writeFile(join(vaultRoot, 'SOP', '子目录', '乙.md'), '乙的正文\n', 'utf8')
  const store = createVaultStore({ vaultRoot, sopDir: 'SOP', backupDir: join(vaultRoot, 'backups') })

  const tree = await store.tree()
  check('vault 树含目录与笔记', tree.length === 2 && tree[0].type === 'dir' && tree[0].count === 1)
  const listed = await store.discover({ force: true })
  check('vault 发现两篇', listed.source === 'fs' && listed.notes.length === 2)

  const note = await store.readNote('SOP/甲.md')
  check('vault 小节切片', note.sections.length === 2 && note.sections[1].title === '小节一')
  check('vault 摘要去 markdown', previewOf(note.text).startsWith('甲 第一段') || previewOf(note.text).startsWith('第一段'), previewOf(note.text))

  const conflict = await store.writeNote('SOP/甲.md', 'x', { expectedSha1: 'deadbeef' }).then(() => 'WROTE', (error) => error.code)
  check('vault 指纹不符拒写', conflict === 'conflict')
  const saved = await store.writeNote('SOP/甲.md', '改后正文\n', { expectedSha1: note.sha1 })
  check('vault 正确指纹写入', saved.sha1.length === 40)
  check('vault 备份落在指定目录', (await readFile(join(vaultRoot, 'backups', 'SOP__甲.md.bak'), 'utf8')).includes('第一段'))
  check('vault 笔记旁没有 .bak', await readFile(join(vaultRoot, 'SOP', '甲.md.bak'), 'utf8').then(() => false, () => true))
  check('vault 同名新建被拒', await store.createNote('SOP/甲.md', 'x').then(() => 'CREATED', (error) => error.code) === 'exists')
  check('vault 越界被拒', await store.readNote('../../etc/passwd').then(() => 'READ', (error) => error.code) === 'bad_path')
  check('vault 深链不带 .md 且编码', store.uriFor('SOP/子目录/乙.md') === 'obsidian://open?vault=vault&file=SOP/%E5%AD%90%E7%9B%AE%E5%BD%95/%E4%B9%99', store.uriFor('SOP/子目录/乙.md'))

  /* ------------------------------------------------------------ 解析边界 */
  check('sectionsOf 忽略空白开头', sectionsOf('\n\n**一**\n正文\n').length === 1)
  check('sectionsOf 保留开头顶部正文', sectionsOf('前言\n\n**一**\n正文\n')[0].title === '（开头）')
} finally {
  await tmp.cleanup()
  await rm(tmp.dir, { recursive: true, force: true }).catch(() => {})
}

assert.ok(report())
