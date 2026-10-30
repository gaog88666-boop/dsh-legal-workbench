/**
 * 法宝积分：直接问账户 MCP（0 积分/次）。
 *
 * 为什么不用 ctx 里的 MCP 客户端：那是给 Agent 的工具通道，卡片要的是"看一眼余额"，
 * 不需要一个会话、也不需要一次工具调用记录。这里按 MCP streamable-http 走三步握手
 * （initialize → notifications/initialized → tools/call），只取 structuredContent。
 *
 * token 纪律：只在内存里用，任何返回、日志、错误文案都不回显；缺 token 就明确说缺 token。
 * 失败不阻塞其它卡片：60 秒缓存里的旧值带 stale 标记继续显示。
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_TTL_MS = 60 * 1000
const TIMEOUT_MS = 15000
const PROTOCOL_VERSION = '2025-06-18'

/** 解析 profile patch 里的 Authorization（从 mcp-pkulaw-law 那一行起找）。 */
function tokenFromPatch(text) {
  const match = String(text).match(/serverName:\s*pkulaw_law[\s\S]*?Authorization:\s*(.+)/)
  if (match === null) return null
  let value = match[1].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value === '' ? null : value
}

/** 候选 patch 文件：显式配置 > 当前 profile > ~/.dsh/profiles/*。 */
async function candidatePatchFiles(explicit) {
  const files = []
  if (typeof explicit === 'string' && explicit !== '') files.push(explicit)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') files.push(join(profileDir, 'cordis.patch.yml'))
  try {
    const root = join(homedir(), '.dsh', 'profiles')
    for (const name of await readdir(root)) files.push(join(root, name, 'cordis.patch.yml'))
  } catch {
    // 没有 profiles 目录就只试前面几个候选。
  }
  return files
}

/** 取 token：配置优先，其次 profile patch。返回值永不外泄到响应里。 */
export async function resolveToken(config) {
  if (typeof config.pkulawToken === 'string' && config.pkulawToken.trim() !== '') {
    const value = config.pkulawToken.trim()
    return value.toLowerCase().startsWith('bearer ') ? value : 'Bearer ' + value
  }
  for (const file of await candidatePatchFiles(config.pkulawPatchFile)) {
    try {
      const token = tokenFromPatch(await readFile(file, 'utf8'))
      if (token !== null) return token
    } catch {
      // 读不到就试下一个候选。
    }
  }
  return null
}

function parseBody(raw, contentType) {
  if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    return data === '' ? null : JSON.parse(data)
  }
  return raw.trim() === '' ? null : JSON.parse(raw)
}

/**
 * 一次 MCP 调用：握手 + tools/call。
 * @returns {Promise<object>} tools/call 的 result
 */
async function callTool(url, token, name, args) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let sessionId = null

  const send = async (payload, { notify = false } = {}) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: token,
    }
    if (sessionId !== null) headers['mcp-session-id'] = sessionId
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const sid = response.headers.get('mcp-session-id')
    if (sid !== null) sessionId = sid
    const raw = await response.text()
    if (notify) return { status: response.status, body: null }
    let body = null
    try {
      body = parseBody(raw, response.headers.get('content-type'))
    } catch {
      body = null
    }
    return { status: response.status, body, raw: raw.slice(0, 400) }
  }

  try {
    const init = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-workbench', version: '0.1.0' } },
    })
    if (init.status === 401 || init.status === 403) throw Object.assign(new Error('法宝 token 被拒绝（HTTP ' + init.status + '）'), { code: 'unauthorized' })
    if (init.status >= 400) throw Object.assign(new Error('法宝握手失败（HTTP ' + init.status + '）'), { code: 'handshake_failed' })
    await send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, { notify: true })
    const call = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
    if (call.status === 401 || call.status === 403) throw Object.assign(new Error('法宝 token 被拒绝（HTTP ' + call.status + '）'), { code: 'unauthorized' })
    if (call.status >= 400) throw Object.assign(new Error('法宝调用失败（HTTP ' + call.status + '）'), { code: 'call_failed' })
    const result = call.body === null ? null : call.body.result
    if (result === null || typeof result !== 'object') {
      throw Object.assign(new Error('法宝返回里没有 result'), { code: 'bad_response' })
    }
    if (result.isError === true) {
      const text = Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string' ? result.content[0].text : ''
      throw Object.assign(new Error(text === '' ? '法宝返回错误' : text.slice(0, 200)), { code: 'tool_error' })
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** structuredContent 优先；缺失时从 text 里抠数字（服务端结构变了也不至于全丢）。 */
export function normalizeBalance(result) {
  const structured = result !== null && typeof result === 'object' && result.structuredContent !== null && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : null
  const text = Array.isArray(result?.content) && typeof result.content[0]?.text === 'string' ? result.content[0].text : ''
  const pickNumber = (pattern) => {
    const match = text.match(pattern)
    return match === null ? undefined : Number(match[1])
  }
  const number = (value, fallbackPattern) => (Number.isFinite(value) ? value : pickNumber(fallbackPattern))
  return {
    availablePoints: number(structured?.availablePoints, /可用积分\s*(\d+)/),
    expiringPoints: number(structured?.expiringPoints, /即将过期\s*(\d+)/),
    expiringWindowDays: number(structured?.expiringWindowDays, /(\d+)\s*天内/),
    nearestExpireOn: typeof structured?.nearestExpireOn === 'string' ? structured.nearestExpireOn : (text.match(/最近过期日\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1],
    accountStatus: typeof structured?.accountStatus === 'string' ? structured.accountStatus : undefined,
    portalPointsUrl: typeof structured?.portalPointsUrl === 'string' ? structured.portalPointsUrl : 'https://mcp.pkulaw.com/console/points',
  }
}

/**
 * 余额读取器：60 秒内存缓存；失败时把上一次的好结果带 stale 返回。
 */
export function createPkulawReader({ getConfig }) {
  let cache = null

  /** 只读缓存，绝不触发网络：overview 用它报"上次拿到的余额"。 */
  function peek() {
    if (cache === null) return null
    return {
      ok: true,
      balance: cache.value,
      cached: true,
      stale: Date.now() - cache.at >= CACHE_TTL_MS,
    }
  }

  async function fetchNow() {
    const config = getConfig()
    const token = await resolveToken(config)
    if (token === null) throw Object.assign(new Error('没有可用的法宝 token（填写 pkulawToken 或确认 profile 里有 mcp-pkulaw-law 行）'), { code: 'no_token' })
    const url = typeof config.pkulawAccountUrl === 'string' && config.pkulawAccountUrl !== '' ? config.pkulawAccountUrl : 'https://apim-gateway.pkulaw.com/pkulaw-account/mcp'
    const result = await callTool(url, token, 'get_points_balance', { expiringWindowDays: 30 })
    const balance = normalizeBalance(result)
    return {
      ...balance,
      fetchedAt: new Date().toISOString(),
      // 计划里的启发式：当日余额 ≥100 视为今天已经领过（每日 10000，当天有效）。
      claimedToday: Number.isFinite(balance.availablePoints) ? balance.availablePoints >= 100 : undefined,
    }
  }

  return {
    peek,
    async get({ force = false } = {}) {
      if (!force && cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
        return { ok: true, balance: cache.value, cached: true }
      }
      try {
        const value = await fetchNow()
        cache = { at: Date.now(), value }
        return { ok: true, balance: value, cached: false }
      } catch (error) {
        const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown'
        const message = error instanceof Error ? error.message : String(error)
        if (cache !== null) {
          return { ok: true, balance: { ...cache.value, stale: true }, cached: true, warning: message, code }
        }
        return { ok: false, code, message }
      }
    },
  }
}
