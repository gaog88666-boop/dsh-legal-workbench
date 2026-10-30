/**
 * 讯飞听见本机 MCP 客户端（长录音备选引擎）。
 *
 * 它是什么：讯飞听见 App 在 localhost:3000 起的一个 MCP 服务（SSE 传输），
 * 只有一个工具 `transcribe_audio`：给本地文件路径 + outputType + 语言，整段转写。
 * 实测 9.5 秒音频约 7.5 秒返回；比火山流式慢，但不排队、单文件一口气处理，
 * 适合"我先上传，等它慢慢转"的长录音。
 *
 * 协议流程：GET /sse 拿到 endpoint（带 sessionId）→ POST JSON-RPC 到该 endpoint，
 * 响应仍从 SSE 流里回来。整套只在 Host 侧运行，X-API-Key 不出现在任何响应里。
 */
import { randomUUID } from 'node:crypto'

/** 一条 SSE 流的解析器：把 `event:`/`data:` 帧还原成对象。 */
function createSseReader(stream, onFrame) {
  const decoder = new TextDecoder()
  let buffer = ''
  return (async () => {
    const reader = stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const lines = frame.split('\n')
          const event = (lines.find((line) => line.startsWith('event:')) ?? 'event: message').slice(6).trim()
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (data !== '') onFrame(event, data)
        }
      }
    } catch {
      // 客户端主动关闭时会抛，忽略。
    }
  })()
}

/**
 * 用听见转写一个本地文件。
 * @returns {Promise<{text: string, utterances: {text: string, start: number, end: number}[], elapsedMs: number}>}
 */
export async function transcribeWithIflyrec({ endpoint, apiKey, filePath, language = 'CN', timeoutMs = 20 * 60 * 1000 }) {
  const base = String(endpoint).replace(/\/sse$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()

  const headers = { 'X-API-Key': apiKey, accept: 'text/event-stream' }
  let response
  try {
    response = await fetch(endpoint, { headers, signal: controller.signal })
  } catch (error) {
    clearTimeout(timer)
    throw Object.assign(new Error('连不上讯飞听见（localhost:3000）——确认听见 App 在后台运行'), { code: 'iflyrec_down' })
  }
  if (!response.ok || response.body === null) {
    clearTimeout(timer)
    throw Object.assign(new Error('讯飞听见 MCP 拒绝了连接（HTTP ' + response.status + '）'), { code: 'iflyrec_down' })
  }

  let endpointPath = null
  const inbox = []
  let waiter = null
  const notify = (message) => {
    inbox.push(message)
    if (waiter !== null) {
      const pending = waiter
      waiter = null
      pending(message)
    }
  }

  void createSseReader(response.body, (event, data) => {
    if (event === 'endpoint') {
      endpointPath = data
      return
    }
    try {
      notify(JSON.parse(data))
    } catch {
      // 非 JSON 帧（心跳等）忽略。
    }
  })

  const waitFor = (predicate, label, ms = 60000) => {
    const existing = inbox.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('等待讯飞听见超时：' + label)), ms)
      waiter = (message) => {
        if (predicate(message)) {
          clearTimeout(guard)
          resolve(message)
        } else {
          waiter = message === undefined ? null : (next) => {
            if (predicate(next)) {
              clearTimeout(guard)
              resolve(next)
            }
          }
        }
      }
    })
  }

  try {
    for (let attempt = 0; attempt < 50 && endpointPath === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (endpointPath === null) throw new Error('讯飞听见没有返回 endpoint')

    const target = base + endpointPath
    const rpc = async (id, method, params) => {
      const result = await fetch(target, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      })
      return result
    }

    await rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-workbench', version: '0.4.0' },
    })
    await waitFor((message) => message.id === 1, 'initialize')

    const started = Date.now()
    await rpc(2, 'tools/call', {
      name: 'transcribe_audio',
      arguments: { filePath, outputType: [1, 2], transcriptLanguage: language },
    })
    const reply = await waitFor((message) => message.id === 2, '转写结果', timeoutMs - 5000)

    const content = reply.result?.content
    const raw = Array.isArray(content) && typeof content[0]?.text === 'string' ? content[0].text : ''
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('讯飞听见返回的不是 JSON：' + raw.slice(0, 120))
    }
    if (parsed?.success !== true) {
      throw new Error('讯飞听见转写失败：' + (parsed?.message ?? parsed?.error ?? '未知原因'))
    }

    const json = parsed?.data?.transcriptResults?.results?.JSON?.data?.transcriptResult
    const paragraphs = Array.isArray(json?.ps) ? json.ps : []
    const utterances = []
    for (const paragraph of paragraphs) {
      const text = (Array.isArray(paragraph.words) ? paragraph.words : [])
        .map((word) => (typeof word?.text === 'string' ? word.text : ''))
        .join('')
        .trim()
      if (text === '') continue
      const span = Array.isArray(paragraph.pTime) ? paragraph.pTime : [0, 0]
      utterances.push({ text, start: Number(span[0] ?? 0), end: Number(span[1] ?? 0) })
    }
    const txt = parsed?.data?.transcriptResults?.results?.TXT?.data?.content
    const text = utterances.map((utterance) => utterance.text).join('') || (typeof txt === 'string' ? txt : '')
    return { text, utterances, elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
    try {
      controller.abort()
    } catch {
      // 已经结束。
    }
    void randomUUID
  }
}
