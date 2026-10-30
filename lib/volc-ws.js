/**
 * 最小 WebSocket 客户端（只用 node:tls，无第三方依赖）。
 *
 * 为什么自己写：浏览器与 Node 内置的 WebSocket 都不允许自定义握手头，
 * 而火山语音的鉴权恰恰在头里（X-Api-Key / X-Api-Resource-Id）。
 * 这里只实现客户端必需的部分：握手、发送二进制帧（带掩码）、读帧、ping/pong、关闭。
 */
import tls from 'node:tls'
import { createHash, randomBytes } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 单帧上限：音频包 200ms 才 6.4KB，留足余量即可。 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

export function connectWebSocket({ host, path, headers = {}, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const expected = createHash('sha1').update(key + GUID).digest('base64')
    const socket = tls.connect({ host, port: 443, servername: host })
    let buffer = Buffer.alloc(0)
    let handshaken = false
    const listeners = new Set()
    const closeListeners = new Set()
    const timer = setTimeout(() => {
      reject(new Error('WebSocket 握手超时'))
      socket.destroy()
    }, timeoutMs)

    const api = {
      send(payload) {
        if (socket.destroyed) return
        socket.write(encodeFrame(0x2, Buffer.from(payload)))
      },
      close() {
        if (socket.destroyed) return
        try {
          socket.write(encodeFrame(0x8, Buffer.alloc(0)))
        } catch {
          // 连接可能已经断了，忽略。
        }
        socket.end()
      },
      onMessage(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      onClose(fn) {
        closeListeners.add(fn)
      },
    }

    socket.on('error', (error) => {
      clearTimeout(timer)
      if (!handshaken) reject(error)
    })
    socket.on('close', () => {
      for (const fn of closeListeners) fn()
    })
    socket.on('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ].join('\r\n'))
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 4)
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
        if (!head.startsWith('HTTP/1.1 101') || accept !== expected) {
          clearTimeout(timer)
          const body = buffer.toString('utf8').slice(0, 400)
          reject(new Error('WebSocket 握手失败：' + head.split('\r\n')[0] + (body === '' ? '' : ' · ' + body)))
          socket.destroy()
          return
        }
        handshaken = true
        clearTimeout(timer)
        resolve(api)
      }
      while (true) {
        const frame = readFrame(buffer)
        if (frame === null) break
        buffer = buffer.subarray(frame.consumed)
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload))
          continue
        }
        if (frame.opcode === 0x8) {
          socket.end()
          return
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
          for (const fn of listeners) fn(frame.payload)
        }
      }
    })
  })
}

function encodeFrame(opcode, payload) {
  const mask = randomBytes(4)
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

function readFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (length > MAX_FRAME_BYTES) throw new Error('WebSocket 帧过大：' + length)
  let mask = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  let payload = buffer.subarray(offset, offset + length)
  if (mask !== null) {
    payload = Buffer.from(payload)
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  }
  return { opcode, payload, consumed: offset + length }
}
