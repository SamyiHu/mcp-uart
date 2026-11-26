/**
 * Fake UART hub for UI verification: same HTTP API as the real Hub, synthetic
 * frames, no serial hardware, never touches a real port.
 *
 *   node test/fake-hub-server.mjs 8795 C:/temp/mcp-uart-fake/hub.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHub } from '../dist/hub/server.js'
import { FakeHubBackend } from './helpers/fake-hub-backend.mjs'
import { FakeOrchestratorBackend } from './helpers/fake-orchestrator-backend.mjs'

const port = Number(process.argv[2] || 8795)
const discoveryFile = process.argv[3]
const backend = new FakeHubBackend()
const hub = await createHub({ backend, orchestrator: new FakeOrchestratorBackend(backend), host: '127.0.0.1', port })

if (discoveryFile) {
  mkdirSync(dirname(discoveryFile), { recursive: true })
  writeFileSync(
    discoveryFile,
    JSON.stringify(
      { url: hub.url, port: hub.port, pid: process.pid, version: 'fake', startedAt: new Date().toISOString(), hub: 'fake' },
      null,
      2,
    ),
  )
  console.log('discovery file:', discoveryFile)
}

const lines = [
  'BOOT v1.4.0 ready\r\n',
  'ADC ch0=0x03FF ch1=0x01A2\r\n',
  'TEMP=27.5C VDD=3.30V\r\n',
  'WARN low battery\r\n',
]
let counter = 0
setInterval(() => {
  const id = hub.getActiveConnectionId()
  if (id === null) return
  counter += 1
  if (counter % 5 === 0) {
    const text = `CMD ${String(counter).padStart(4, '0')} READ?\r\n`
    backend.emit(id, {
      timestamp: new Date().toISOString(),
      connectionId: id,
      data: text,
      raw: Buffer.from(text, 'utf8').toString('hex').toUpperCase(),
      length: Buffer.byteLength(text, 'utf8'),
      direction: 'tx',
    })
    return
  }
  if (counter % 3 === 0) {
    const text = `[${String(counter).padStart(4, '0')}] ${lines[counter % lines.length]}`
    backend.emitRx(id, [...Buffer.from(text, 'utf8')], text)
  } else {
    const text = `PING ${String(counter).padStart(4, '0')}\r\n`
    backend.emitRx(id, [...Buffer.from(text, 'utf8')], text)
  }
}, 350)

console.log('fake hub:', hub.url)
