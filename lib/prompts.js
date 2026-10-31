/**
 * prompts.json：prompt 模板库。
 *
 * 约定：{"prompts": {"<id>": {"title": "...", "text": "..."}}}
 * 卡片（kind=prompt 或带 promptId 的卡片）按 id 取模板；坏一条只丢那一条。
 */
import { readFile } from 'node:fs/promises'

/** 内置模板：prompts.json 缺失/损坏时的回退（与首次运行写出的种子一致）。 */
export const BUILTIN_PROMPTS = {
  'email-draft': {
    title: '邮件起草',
    text: '起草一封邮件。\n收件人：\n事项：\n要说明的要点：\n要提出的要求：\n语言：中 / 英\n\n先给可编辑正文，缺口用【】标出，不要写签名档（签名由邮箱自动生成）。',
  },
  reimburse: {
    title: '报销填表',
    text: '帮我按报销模板填这张报销单。\n项目：\n事由：\n金额与币种：\n日期与票据：\n\n模板路径：\n填完后把用到模板里哪些字段列出来，便于核对。',
  },
  'glossary-all': {
    title: '整表插入',
    text: '以下是本项目的术语表，本轮翻译严格沿用这些译法，不要自行改词：\n\n',
  },
  'dd-checklist': {
    title: '尽调清单',
    text: '帮我起草一份尽职调查清单。\n交易类型：\n目标公司 / 义务人：\n法域：\n\n按「主体资格 / 授权与决议 / 重大合同 / 担保与抵质押 / 诉讼与处罚 / 合规」分组，每组给要点式清单，并标出需要向对方索取的原始文件。',
  },
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function readPrompts(promptsFile) {
  let text
  try {
    text = await readFile(promptsFile, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') {
      return { prompts: BUILTIN_PROMPTS, source: 'builtin' }
    }
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 读取失败，已用内置模板：' + describe(error) }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 不是合法 JSON，已用内置模板' }
  }
  const raw = parsed !== null && typeof parsed === 'object' && parsed.prompts !== null && typeof parsed.prompts === 'object' ? parsed.prompts : null
  if (raw === null) {
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 缺少 prompts 对象，已用内置模板' }
  }
  const prompts = {}
  for (const key of Object.keys(raw)) {
    const item = raw[key]
    if (item === null || typeof item !== 'object') continue
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    prompts[key] = {
      title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : key,
      text: item.text,
    }
  }
  if (Object.keys(prompts).length === 0) {
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 里没有一条可用模板，已用内置模板' }
  }
  return { prompts, source: 'file' }
}
