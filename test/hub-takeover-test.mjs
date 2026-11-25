/**
 * Hand-over between the panel and the agent.
 *
 * The bug this locks down: when the panel already had the port open, the
 * agent's connect closed it and reopened in the same tick. Windows keeps the
 * handle briefly, the reopen failed with "Access denied", and the agent gave up
 * saying the port was unavailable. Two behaviours are required now:
 *
 *   1. same path already open  → reuse that connection (no close, no reopen)
 *   2. a transient open failure → retry briefly before reporting it
 */
import { createHub } from "../dist/hub/server.js";

let failures = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok: ${name}`))
    .catch((error) => {
      failures += 1
      console.error(`FAIL: ${name}`)
      console.error(`  ${error?.message ?? error}`)
    })
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Minimal backend: one open per path, like a real COM port. */
function createStubBackend(options = {}) {
  const connections = new Map()
  let nextId = 1
  const state = { openCalls: [], closeCalls: [], failNext: options.failNext ?? 0 }

  const backend = {
    async listPorts() {
      return [{ path: 'COM9' }]
    },
    async open(config) {
      state.openCalls.push({ path: config.path, baudRate: config.baudRate })
      if (state.failNext > 0) {
        state.failNext -= 1
        throw new Error('Cannot open COM9: Access denied')
      }
      for (const info of connections.values()) {
        if (info.config.path === config.path) throw new Error(`Cannot open ${config.path}: Access denied`)
      }
      const id = `c${nextId++}`
      connections.set(id, {
        id,
        config,
        status: 'open',
        openedAt: new Date().toISOString(),
        messageCount: 0,
        lastActivity: null,
        error: null,
      })
      return { connectionId: id, status: 'open' }
    },
    async close(id) {
      state.closeCalls.push(id)
      connections.delete(id)
    },
    async write() {
      return { bytesWritten: 0, raw: '' }
    },
    getInfo(id) {
      const info = connections.get(id)
      if (!info) throw new Error(`connection ${id} not found`)
      return info
    },
    listConnections() {
      return [...connections.values()]
    },
    peekMessages() {
      return []
    },
    readFiltered() {
      return []
    },
    async reconfigure(id, updates) {
      const info = connections.get(id)
      if (!info) throw new Error(`connection ${id} not found`)
      info.config = { ...info.config, ...updates }
      return info
    },
    async setSignals() {},
    onMessage() {
      return () => {}
    },
  }
  return { backend, state }
}

const baseConfig = {
  path: 'COM9',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  encoding: 'utf8',
  protocol: 'line',
  bufferSize: 2000,
  dtr: true,
  rts: true,
}

await check('a second connect to the same port hands over instead of reopening', async () => {
  const { backend, state } = createStubBackend()
  const hub = await createHub({ backend, host: '127.0.0.1', port: 0 })

  const first = await (await fetch(`${hub.url}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'COM9' }),
  })).json()
  assert(first.ok === true, `first connect failed: ${JSON.stringify(first)}`)

  const second = await (await fetch(`${hub.url}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'COM9', baudRate: 921600 }),
  })).json()

  assert(second.ok === true, `hand-over failed: ${JSON.stringify(second)}`)
  assert(second.reused === true, 'the response must mark the connection as reused')
  assert(second.connectionId === first.connectionId, 'the same connection id must be kept')
  assert(state.openCalls.length === 1, `open must not run twice (ran ${state.openCalls.length})`)
  assert(second.info.config.baudRate === 921600, 'the new baud rate must be applied to the live connection')

  await hub.close()
})

await check('a different port still replaces the previous connection', async () => {
  const { backend, state } = createStubBackend()
  const hub = await createHub({ backend, host: '127.0.0.1', port: 0 })

  await fetch(`${hub.url}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'COM9' }),
  })
  const second = await (await fetch(`${hub.url}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'COM10' }),
  })).json()

  assert(second.ok === true, `second port failed: ${JSON.stringify(second)}`)
  assert(second.reused !== true, 'a different port must open a new connection')
  assert(state.openCalls.length === 2, `expected two opens, got ${state.openCalls.length}`)
  assert(state.closeCalls.length === 1, 'the previous connection must be closed')

  await hub.close()
})

await check('a transient access-denied open is retried', async () => {
  const { backend, state } = createStubBackend({ failNext: 1 })
  const hub = await createHub({ backend, host: '127.0.0.1', port: 0 })

  const result = await (await fetch(`${hub.url}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'COM9' }),
  })).json()

  assert(result.ok === true, `retry did not succeed: ${JSON.stringify(result)}`)
  assert(state.openCalls.length === 2, `expected a retry (open calls: ${state.openCalls.length})`)

  await hub.close()
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n=== hub takeover tests done ===')
