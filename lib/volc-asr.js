/**
 * 火山引擎豆包流式语音识别（2.0）桥。
 *
 * 为什么放在 Host：浏览器的 WebSocket 不能设置握手头，而火山的鉴权在头里
 * （X-Api-Key / X-Api-Resource-Id）。所以由 Host 代连，客户端只送 PCM、收文本。
 *
 * 协议（实测通过，2026-10-26）：
 *   · 先发一包 JSON 头（messageType 1、flags 0、serialization JSON、无压缩）；
 *   · 再按 200ms 一包发裸 PCM（messageType 2、flags 0，最后一包 flags 2）；
 *   · 服务端回 messageType 9，flags 1 带 sequence，末包 flags 3；payload 是 JSON：
 *     { result: { text, utterances: [{ text, start_time, end_time, definite }] }, sequence }
 *   · 实测：握手 ~170ms、首字 ~1.4s、末包后 123ms 出定稿。
 *
 * 凭据只从 asr.json 读，绝不回显。
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { connectWebSocket } from './volc-ws.js'

const HOST = 'openspeech.bytedance.com'
const PATH = '/api/v3/sauc/bigmodel_async'
const DEFAULT_RESOURCE = 'volc.seedasr.sauc.duration'
/** 会话多久没动静就回收（毫秒）。 */
/**
 * 空闲超时：**只要还有往来就重置**。
 * 早期这里是「建连后 2 分钟必断」的绝对超时，导致任何一次超过 2 分钟的录音都被掐断
 * （错误信息"转写超时（2 分钟无收尾）"）。别改回绝对计时。
 */
const SESSION_IDLE_MS = 2 * 60 * 1000

/** 读 ASR 凭据；只有 Host 侧调用，返回值不进任何响应体。 */
export async function readAsrConfig(configFile) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(configFile, 'utf8'))
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') throw Object.assign(new Error('缺少 ASR 配置：' + configFile), { code: 'no_asr_config' })
    throw Object.assign(new Error('ASR 配置读不了：' + error.message), { code: 'asr_config_failed' })
  }
  const volc = parsed !== null && typeof parsed === 'object' ? parsed.volcengine : null
  const apiKey = typeof volc?.apiKey === 'string' ? volc.apiKey.trim() : ''
  if (apiKey === '') throw Object.assign(new Error('ASR 配置里没有火山 apiKey'), { code: 'no_asr_key' })
  return {
    apiKey,
    resourceId: typeof volc?.resourceIdStreaming === 'string' && volc.resourceIdStreaming !== '' ? volc.resourceIdStreaming : DEFAULT_RESOURCE,
    // 热词表 / 替换词表（可选）：不配就不带 corpus 字段
    boostingTableId: typeof volc?.boostingTableId === 'string' ? volc.boostingTableId.trim() : '',
    boostingTableName: typeof volc?.boostingTableName === 'string' ? volc.boostingTableName.trim() : '',
    correctTableId: typeof volc?.correctTableId === 'string' ? volc.correctTableId.trim() : '',
    correctTableName: typeof volc?.correctTableName === 'string' ? volc.correctTableName.trim() : '',
  }
}

function encodeRequest(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(4)
  header[0] = 0x11 // 协议版本 1，头长 4 字节
  header[1] = 0x10 // messageType 1（full client request）、flags 0
  header[2] = 0x10 // JSON、无压缩
  header[3] = 0x00
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, size, body])
}

function encodeAudio(chunk, isLast) {
  const header = Buffer.alloc(4)
  header[0] = 0x11
  header[1] = (0x2 << 4) | (isLast ? 0x2 : 0x0) // messageType 2，末包 flags 2
  header[2] = 0x00 // 无序列化、无压缩
  header[3] = 0x00
  const size = Buffer.alloc(4)
  size.writeUInt32BE(chunk.length, 0)
  return Buffer.concat([header, size, chunk])
}

function decodeFrame(buf) {
  if (buf.length < 4) return null
  const headerSize = (buf[0] & 0x0f) * 4
  const messageType = buf[1] >> 4
  const flags = buf[1] & 0x0f
  const compression = buf[2] & 0x0f
  let offset = headerSize
  let sequence = null
  if (flags === 1 || flags === 3) {
    sequence = buf.readInt32BE(offset)
    offset += 4
  }
  if (buf.length < offset + 4) return null
  const size = buf.readUInt32BE(offset)
  offset += 4
  let payload = buf.subarray(offset, offset + size)
  if (compression === 1) {
    try {
      payload = gunzipSync(payload)
    } catch {
      // 压缩标记与实际不符时按原文处理。
    }
  }
  return { messageType, flags, sequence, text: payload.toString('utf8') }
}

/**
 * 流式转写桥：一个会话对应一条到火山的 WebSocket。
 * 事件：partial（中间结果，整段覆盖）、final（定稿文本 + 分句） 、error。
 */
/** 从配置里组装 corpus（热词表 / 替换词表）。没配就返回 null，请求里不带这个字段。 */
export function buildCorpus(config) {
  const corpus = {}
  if (typeof config?.boostingTableId === 'string' && config.boostingTableId !== '') corpus.boosting_table_id = config.boostingTableId
  if (typeof config?.boostingTableName === 'string' && config.boostingTableName !== '') corpus.boosting_table_name = config.boostingTableName
  if (typeof config?.correctTableId === 'string' && config.correctTableId !== '') corpus.correct_table_id = config.correctTableId
  if (typeof config?.correctTableName === 'string' && config.correctTableName !== '') corpus.correct_table_name = config.correctTableName
  return Object.keys(corpus).length === 0 ? null : corpus
}

export function createAsrBridge({ getConfigFile, onEvent = () => {} } = {}) {
  const sessions = new Map()

  function emit(id, event) {
    const session = sessions.get(id)
    if (session === undefined) return
    try {
      onEvent(id, event)
    } catch {
      // 订阅方自己的异常不该打断转写。
    }
    if (event.type === 'final' || event.type === 'error') {
      session.done = true
    }
  }

  async function start() {
    const config = await readAsrConfig(getConfigFile())
    const corpusPatch = buildCorpus(config)
    const id = randomUUID()
    const ws = await connectWebSocket({
      host: HOST,
      path: PATH,
      headers: {
        'X-Api-Key': config.apiKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Connect-Id': randomUUID(),
        'X-Api-Request-Id': randomUUID(),
      },
    })

    const session = {
      id,
      ws,
      done: false,
      sentLast: false,
      lastText: '',
      utterances: [],
      startedAt: Date.now(),
      timer: null,
    }
    sessions.set(id, session)

    ws.onMessage((payload) => {
      const frame = decodeFrame(payload)
      if (frame === null) return
      if (frame.messageType === 0xf) {
        emit(id, { type: 'error', message: frame.text.slice(0, 300) })
        return
      }
      if (frame.messageType !== 0x9) return
      let json = null
      try {
        json = JSON.parse(frame.text)
      } catch {
        return
      }
      touch(id)
      const result = json?.result ?? {}
      if (typeof result.text === 'string' && result.text !== '') session.lastText = result.text
      if (Array.isArray(result.utterances)) {
        // 火山每帧给的是「累计」句子列表（不是增量），所以这里覆盖。
        // 早期版本用 push，导致同一句被追加上千次——别改回 push。
        session.utterances = result.utterances
          .filter((utterance) => utterance?.definite === true && typeof utterance.text === 'string' && utterance.text !== '')
          .map((utterance) => ({ text: utterance.text, start: utterance.start_time, end: utterance.end_time }))
      }
      const isLast = frame.flags === 3 || (json?.sequence !== undefined && json.sequence < 0)
      if (isLast) {
        emit(id, {
          type: 'final',
          text: session.lastText,
          utterances: session.utterances,
          elapsedMs: Date.now() - session.startedAt,
        })
      } else if (session.lastText !== '') {
        // 带上已定稿的句子列表：界面在录音过程中就能逐句标注（不再只能看一段流水文本）。
        emit(id, {
          type: 'partial',
          text: session.lastText,
          lines: session.utterances.map((utterance) => ({ text: utterance.text, start: utterance.start, end: utterance.end })),
        })
      }
    })

    ws.onClose(() => {
      if (!session.done) emit(id, { type: 'error', message: '连接被服务端关闭' })
      cleanup(id)
    })

    touch(id)

    ws.send(encodeRequest({
      user: { uid: 'dsh-workbench' },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
        result_type: 'full',
        // 热词/替换词表：不传就是「控制台里配了也不生效」。
        // 词表 ID 从火山控制台「词表管理」里复制，写进 asr.json 的 volc 段。
        ...(corpusPatch === null ? {} : { corpus: corpusPatch }),
      },
    }))

    return id
  }

  /** 重置空闲计时（有往来就算活着）。 */
  function touch(id) {
    const session = sessions.get(id)
    if (session === undefined) return
    if (session.timer !== null) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      if (!session.done) emit(id, { type: 'error', message: '转写中断：2 分钟没有任何往来' })
      cleanup(id)
    }, SESSION_IDLE_MS)
    if (typeof session.timer?.unref === 'function') session.timer.unref()
  }

  /** 送一段裸 PCM（16k/16bit/单声道）。 */
  function push(id, chunk) {
    const session = sessions.get(id)
    if (session === undefined || session.done) return false
    session.ws.send(encodeAudio(Buffer.from(chunk), false))
    touch(id)
    return true
  }

  /** 收尾：最后一包打标记，等服务端定稿。 */
  function finish(id, tail) {
    const session = sessions.get(id)
    if (session === undefined || session.done) return false
    session.sentLast = true
    session.ws.send(encodeAudio(Buffer.from(tail ?? Buffer.alloc(0)), true))
    return true
  }

  function cleanup(id) {
    const session = sessions.get(id)
    if (session === undefined) return
    if (session.timer !== null) clearTimeout(session.timer)
    try {
      session.ws.close()
    } catch {
      // 已经关了。
    }
    sessions.delete(id)
  }

  return {
    start,
    push,
    finish,
    cancel(id) {
      const session = sessions.get(id)
      if (session !== undefined) session.done = true
      cleanup(id)
    },
    get(id) {
      return sessions.get(id)
    },
    size() {
      return sessions.size
    },
  }
}
