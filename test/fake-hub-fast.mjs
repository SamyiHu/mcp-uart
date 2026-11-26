/**
 * High-rate fake hub for render profiling: same API, emits a configurable
 * number of frames per second (default 300).
 *   node test/fake-hub-fast.mjs 8847 [rate]
 */
import { createHub } from '../dist/hub/server.js'
import { FakeHubBackend } from './helpers/fake-hub-backend.mjs'

const port = Number(process.argv[2] || 8847)
const rate = Number(process.argv[3] || 300)
const backend = new FakeHubBackend()
const hub = await createHub({ backend, host: '127.0.0.1', port })

setInterval(() => {
  const id = hub.getActiveConnectionId()
  if (id === null) return
  const text = `PING ${String(Date.now() % 10000).padStart(4, '0')}\r\n`
  backend.emitRx(id, [...Buffer.from(text, 'utf8')], text)
}, Math.max(1, Math.round(1000 / rate)))

console.log(`fast fake hub: ${hub.url} @ ${rate} frames/s`)
