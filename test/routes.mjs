/**
 * 路由端到端：用假 webServer 直接打 HTTP handler，不启动 App。
 *
 * 两组：
 *   ① 只读组——打真实 vault（不存在则跳过），验证 overview / 树 / 单篇 / 搜索 / 邮件 / 卡片；
 *   ② 写入组——全部落在临时目录，验证指纹冲突、备份位置、新建、越界拦截、术语 CRUD、深链。
 *
 * 法宝余额会走真实网络（0 积分/次），默认跳过；要跑加 WB_TEST_NETWORK=1。
 */
import assert from 'node:assert/strict'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { REAL_SOP, REAL_VAULT, createReporter, mount, tempDir } from './helpers.mjs'

const { check, report } = createReporter('routes')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- ① 只读 */

if (await exists(join(REAL_VAULT, REAL_SOP))) {
  const call = await mount({})

  const overview = await call('GET', '/overview')
  check('overview 200', overview.status === 200)
  check('overview 卡片数 ≥ 5', Array.isArray(overview.json?.cards) && overview.json.cards.length >= 5, overview.json?.cards?.length)
  const sopCard = overview.json.cards.find((card) => card.kind === 'sop')
  check('SOP 卡有笔记数', sopCard !== undefined && sopCard.stats.count > 0, JSON.stringify(sopCard?.stats))

  const listing = await call('GET', '/sop')
  check('SOP 走 fs', listing.json?.source === 'fs', listing.json?.source)
  check('SOP 列表与卡片计数一致', listing.json.notes.length === sopCard.stats.count, listing.json.notes.length)
  check('SOP 带目录树', Array.isArray(listing.json.tree) && listing.json.tree.length > 0)
  check('树节点带计数', listing.json.tree.every((node) => node.type === 'note' || Number.isInteger(node.count)))

  const firstNote = listing.json.notes[0]
  const single = await call('GET', '/sop?note=' + encodeURIComponent(firstNote.path))
  check('读单篇带正文与指纹', single.status === 200 && single.json.note.text.length > 0 && single.json.note.sha1.length === 40)
  check('读单篇带小节', Array.isArray(single.json.note.sections))

  const search = await call('GET', '/search?q=' + encodeURIComponent('的'))
  check('全局搜索有命中', search.status === 200 && search.json.hits.length > 0, search.json?.hits?.length)
  check('搜索命中带来源', search.json.hits.every((hit) => ['sop', 'glossary', 'email', 'recording'].includes(hit.source)))

  const emptySearch = await call('GET', '/search?q=')
  check('空搜索返回空', emptySearch.json.hits.length === 0)

  const cards = await call('GET', '/cards')
  check('/cards 200', cards.status === 200 && Array.isArray(cards.json.cards))
  const prompts = await call('GET', '/prompts')
  check('/prompts 200', prompts.status === 200 && typeof prompts.json.prompts === 'object')

  const glossary = await call('GET', '/glossary')
  check('/glossary 200', glossary.status === 200 && Array.isArray(glossary.json.entries))

  const email = await call('GET', '/email')
  check('/email 200', email.status === 200)

  check('未知路由 404', (await call('GET', '/nope')).status === 404)
  check('错误方法 405', (await call('DELETE', '/overview')).status === 405)

  if (process.env.WB_TEST_NETWORK === '1') {
    const balance = await call('GET', '/pkulaw')
    check('法宝余额可取（联网）', balance.status === 200 && Number.isFinite(balance.json.balance.availablePoints), balance.raw.slice(0, 120))
  } else {
    console.log('  · 跳过法宝联网测试（WB_TEST_NETWORK=1 可开）')
  }
} else {
  console.log('  · 跳过真实 vault 只读测试（' + join(REAL_VAULT, REAL_SOP) + ' 不存在）')
}

/* ---------------------------------------------------------------- ② 写入 */

const tmp = await tempDir()
try {
  const vaultRoot = join(tmp.dir, 'vault')
  await mkdir(join(vaultRoot, 'SOP', 'Stage I'), { recursive: true })
  await writeFile(join(vaultRoot, 'SOP', '甲.md'), '# 甲\n原文\n', 'utf8')
  const glossaryFile = join(tmp.dir, '术语表.md')
  const dataDir = join(tmp.dir, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'cards.json'), JSON.stringify({ cards: [{ id: 'sop', kind: 'sop', title: 'SOP', order: 10 }] }), 'utf8')
  await writeFile(join(dataDir, 'prompts.json'), JSON.stringify({ prompts: {} }), 'utf8')

  // 邮件规则库：用临时技能目录，绝不能碰真实的 style-rules.md
  const skillDir = join(tmp.dir, 'skill')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  const rulesSource = ['# 规则库', '', '## 计数', '', '| 指标 | 值 |', '|---|---|', '| 硬规则数 | 0 |', '| 软规则数 | 0 |', '| 待观察（已批准，命中 <3 次） | 0 |', '', '## 待观察（已批准，命中 <3 次，同样遵守）', '', '（空）', ''].join('\n')
  await writeFile(join(skillDir, 'references', 'style-rules.md'), rulesSource, 'utf8')

  const call = await mount({
    vaultRoot,
    sopDir: 'SOP',
    workbenchDir: 'Workbench',
    recordingsDir: 'Recordings',
    dataDir,
    glossaryFile,
    emailSkillDir: skillDir,
    openCommand: '/bin/echo',
  })

  const current = await call('GET', '/sop?note=' + encodeURIComponent('SOP/甲.md'))
  check('临时 vault 读到正文', current.status === 200 && current.json.note.text.includes('原文'))

  const conflict = await call('PUT', '/sop/note', { path: 'SOP/甲.md', text: 'x', expectedSha1: 'deadbeef' })
  check('指纹不符 409', conflict.status === 409 && conflict.json.code === 'conflict')

  const saved = await call('PUT', '/sop/note', {
    path: 'SOP/甲.md',
    text: '# 甲\n改后\n',
    expectedSha1: current.json.note.sha1,
  })
  check('指纹正确写入', saved.status === 200, saved.raw.slice(0, 120))
  check('磁盘内容已变', (await readFile(join(vaultRoot, 'SOP', '甲.md'), 'utf8')).includes('改后'))
  check('备份落到隐藏目录', (await readFile(join(vaultRoot, 'Workbench/.backups/SOP__甲.md.bak'), 'utf8')).includes('原文'))

  const created = await call('POST', '/sop/note', { path: 'SOP/Stage I/乙.md', text: '# 乙\n' })
  check('新建笔记', created.status === 200 && created.json.note.path === 'SOP/Stage I/乙.md')
  check('同名新建 409', (await call('POST', '/sop/note', { path: 'SOP/Stage I/乙.md', text: 'x' })).status === 409)
  check('越界 400', (await call('PUT', '/sop/note', { path: '../x.md', text: 'x' })).status === 400)
  check('缺字段 400', (await call('PUT', '/sop/note', { path: 'SOP/甲.md' })).status === 400)

  const added = await call('POST', '/glossary', { zh: '差额补足', en: 'Shortfall Undertaking', field: '增信' })
  check('术语新增', added.status === 200 && added.json.total === 1, added.raw.slice(0, 120))
  check('术语重复 400', (await call('POST', '/glossary', { zh: '差额补足', en: 'Shortfall Undertaking' })).status === 400)
  const updated = await call('PUT', '/glossary/' + added.json.entry.id, { zh: '差额补足', en: 'Shortfall Undertaking Agreement' })
  check('术语修改', updated.status === 200)
  check('术语删除', (await call('DELETE', '/glossary/' + updated.json.entry.id)).status === 200)
  check('术语删不存在 404', (await call('DELETE', '/glossary/deadbeef0000')).status === 404)



  /* ------------------------------------------------------- 录音（临时 vault） */

  if (process.env.WB_TEST_NETWORK === '1') {
    const usage = await call('GET', '/usage')
    check('用量接口 200', usage.status === 200 && usage.json.ok === true, usage.raw.slice(0, 160))
    check('用量接口含 deepseek/volc', usage.json.deepseek !== undefined && usage.json.volc !== undefined)
  }

  const rec = await call('POST', '/recordings', { title: '单元测试' })
  check('新建录音 200', rec.status === 200 && typeof rec.json.id === 'string', rec.raw.slice(0, 120))
  const recId = rec.json.id
  const pcm = Buffer.alloc(6400)
  for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE(Math.round(Math.sin(index / 20) * 12000), index)
  const chunk1 = await call('POST', '/recordings/' + encodeURIComponent(recId) + '/chunk', pcm)
  check('写入音频分片', chunk1.status === 200 && chunk1.json.bytes === 6400, chunk1.raw.slice(0, 120))
  const fin = await call('POST', '/recordings/' + encodeURIComponent(recId) + '/finalize', {})
  check('收尾修正时长', fin.status === 200 && fin.json.durationMs >= 190 && fin.json.durationMs <= 210, JSON.stringify(fin.json))

  const listed = await call('GET', '/recordings')
  check('录音出现在列表', listed.json.items.some((item) => item.id === recId), listed.json.items.length)
  const peaks = await call('GET', '/recordings/' + encodeURIComponent(recId) + '/peaks')
  check('波形峰值 160 段', Array.isArray(peaks.json.peaks) && peaks.json.peaks.length === 160)
  const put = await call('PUT', '/recordings/' + encodeURIComponent(recId) + '/transcript', { text: '# 转写\n- 测试\n' })
  check('写转写稿', put.status === 200)
  const got = await call('GET', '/recordings/' + encodeURIComponent(recId) + '/transcript')
  check('读回转写稿', got.json.exists === true && got.json.text.includes('测试'))
  {
    const escape = await call('GET', '/recordings/..%2F..%2Fetc/audio')
    check('录音 id 越界 400', escape.status === 400, escape.status + ' ' + escape.raw.slice(0, 120))
  }


  // Range：单独造一个能接流的 res
  {
    const req = {
      method: 'GET',
      url: '/api/dsh-workbench/recordings/' + encodeURIComponent(recId) + '/audio',
      headers: { host: '127.0.0.1:58900', range: 'bytes=44-143' },
      socket: { remoteAddress: '127.0.0.1' },
      on() {},
      async *[Symbol.asyncIterator]() {},
    }
    let head = null
    let received = 0
    const res = {
      writeHead(status, headers) { head = { status, headers } },
      write(chunk) { received += chunk.length; return true },
      end() {},
      on() {},
      once() {},
      emit() {},
      removeListener() {},
    }
    await call.handler(req, res)
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('Range 返回 206', head !== null && head.status === 206, JSON.stringify(head))
    check('Range 头正确', head !== null && String(head.headers['content-range']).startsWith('bytes 44-143/'), JSON.stringify(head?.headers))
    check('Range 只传 100 字节', received === 100, received)
  }

  const savedAnn = await call('PUT', '/recordings/' + encodeURIComponent(recId) + '/annotations', {
    annotations: [{ id: 'a1', quote: '测试', note: '我的批注', color: 'yellow', time: 0, line: 0 }],
  })
  check('批注保存', savedAnn.status === 200 && savedAnn.json.annotations.length === 1, savedAnn.raw.slice(0, 120))
  const readAnn = await call('GET', '/recordings/' + encodeURIComponent(recId) + '/annotations')
  check('批注读回', readAnn.json.annotations[0]?.note === '我的批注')
  check('批注定位到行', readAnn.json.annotations[0]?.stale === false)
  check('转写稿追加批注附录', (await readFile(join(vaultRoot, 'Recordings', recId, '转写.md'), 'utf8')).includes('## 批注'))

  const recSearch = await call('GET', '/search?q=' + encodeURIComponent('测试'))
  check('搜索命中录音转写', recSearch.json.hits.some((hit) => hit.source === 'recording'), JSON.stringify(recSearch.json.counts))
  const recHit = recSearch.json.hits.find((hit) => hit.source === 'recording')
  check('录音命中带日期', /^\d{4}-\d{2}-\d{2}$/.test(recHit?.date ?? ''), recHit?.date)
  const annSearch = await call('GET', '/search?q=' + encodeURIComponent('我的批注'))
  check('搜索命中录音批注', annSearch.json.hits.some((hit) => hit.source === 'recording'), JSON.stringify(annSearch.json.counts))

  const renamed = await call('POST', '/recordings/' + encodeURIComponent(recId) + '/rename', { title: '改过名' })
  check('改名 200', renamed.status === 200 && renamed.json.id !== recId, renamed.raw.slice(0, 120))
  check('改名保留日期前缀', /^\d{4}-\d{2}-\d{2} \d{4} 改过名$/.test(renamed.json.id), renamed.json.id)
  const finalId = renamed.json.id
  check('改名后旧目录不在列表', !(await call('GET', '/recordings')).json.items.some((item) => item.id === recId))

  const removed = await call('DELETE', '/recordings/' + encodeURIComponent(finalId))
  check('删除录音 200', removed.status === 200, removed.raw.slice(0, 120))
  const afterDelete = await call('GET', '/recordings')
  check('删除后不在列表', !afterDelete.json.items.some((item) => item.id === finalId))
  check('删除后可回收（.trash）', await readFile(join(vaultRoot, 'Recordings', '.trash', finalId, 'audio.wav')).then(() => true, () => false))

  const open = await call('POST', '/open-obsidian', { path: 'SOP/甲.md' })
  check('深链由 Host 拼装', open.status === 200 && open.json.uri.startsWith('obsidian://open?vault=vault&file=SOP/'), open.json?.uri)
  check('深链越界 400', (await call('POST', '/open-obsidian', { path: '../../etc/passwd' })).status === 400)
  const rulesRead = await call('GET', '/email/rules')
  check('规则库可读', rulesRead.status === 200 && Array.isArray(rulesRead.json.items), rulesRead.raw.slice(0, 120))

  const rulesPut = await call('PUT', '/email/rules', {
    items: [{ id: 'R-900', title: '测试规则', section: 'watch', fields: { 规则: '测试内容', 证据: '', 来源: '测试', 强度: '软', 反例: '' } }],
  })
  check('规则库可写', rulesPut.status === 200, rulesPut.raw.slice(0, 160))
  const rulesAfter = await call('GET', '/email/rules')
  check('写入后能读回', rulesAfter.json.items.some((item) => item.id === 'R-900' && item.fields['规则'] === '测试内容'))
  {
    const backups = await readdir(join(dataDir, '.backups')).catch(() => [])
    check('写前有备份', backups.some((name) => name.startsWith('email-rules-')), backups.join(','))
  }
  const badRule = await call('PUT', '/email/rules', { items: [{ id: 'X-1', title: 't', section: 'watch', fields: { 规则: 'r' } }] })
  check('非法编号被拒', badRule.status === 400, badRule.raw.slice(0, 120))

} finally {
  await tmp.cleanup()
}

assert.ok(report())
