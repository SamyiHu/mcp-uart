/**
 * End-to-end checks for the Rust daemon's Orchestrator HTTP surface.
 * Starts `uartd hub` on an ephemeral port and probes /api/orchestrator* exactly as the
 * panel does. No serial hardware needed for these routes.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const EXE = process.env.UARTD_BIN || 'E:/cargo-target/uartd/release/uartd.exe'
const PROFILES = 'E:/Desktop_Projects/小程序/MCP_Uart/src/orchestrator/profiles'

let failures = 0
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`ok: ${name}`))
    .catch((error) => {
      failures++
      console.error(`FAIL: ${name}`)
      console.error(`  ${error?.message ?? error}`)
    })
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })
      if (r.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('uartd did not become healthy')
}

async function req(base, method, path, body) {
  const init = { method, signal: AbortSignal.timeout(3000) }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const r = await fetch(`${base}${path}`, init)
  const text = await r.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = { text } }
  return { status: r.status, payload }
}

// Pick a free port by binding 0 then closing.
const net = await import('node:net')
const probe = net.createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
probe.close()
await once(probe, 'close')

const child = spawn(EXE, ['hub', '--host', '127.0.0.1', '--port', String(port), '--port-span', '0'], {
  env: { ...process.env, UART_Orchestrator_PROFILES: PROFILES },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (c) => { stderr += c.toString() })

const base = `http://127.0.0.1:${port}`

try {
  await waitForHealth(base)

  await check('health reports orchestrator:true and features.orchestrator:true', async () => {
    const { payload } = await req(base, 'GET', '/api/health')
    assert(payload.orchestrator === true, 'health.orchestrator must be true')
    assert(payload.features?.orchestrator === true, 'features.orchestrator must be true')
    assert(payload.features?.history === true, 'features.history must stay true')
  })

  await check('/api/orchestrator lists the shipped profiles', async () => {
    const { payload } = await req(base, 'GET', '/api/orchestrator')
    assert(payload.ok === true && payload.available === true, 'orchestrator must be available')
    const names = payload.profiles.map((p) => p.name)
    assert(names.includes('frame-demo'), `frame-demo missing: ${names}`)
    assert(names.includes('text-console'), `text-console missing: ${names}`)
    const fd = payload.profiles.find((p) => p.name === 'frame-demo')
    assert(fd.commands.length >= 3, `frame-demo commands too few: ${fd.commands.length}`)
    assert(fd.smoke.includes('read_value'), 'frame-demo smoke must include read_value')
  })

  await check('/api/orchestrator/status describes a disconnected session', async () => {
    const { status, payload } = await req(base, 'GET', '/api/orchestrator/status')
    assert(status === 200, `status ${status}`)
    assert(payload.status.connected === false, 'must report disconnected')
    assert(payload.status.busy === false, 'must report not busy')
  })

  await check('orchestrator/connect requires profile', async () => {
    const { status, payload } = await req(base, 'POST', '/api/orchestrator/connect', {})
    assert(status === 400, `expected 400, got ${status}`)
    assert(String(payload.error).includes('profile'), `error text: ${payload.error}`)
  })

  await check('orchestrator/connect with unknown profile is rejected', async () => {
    const { status, payload } = await req(base, 'POST', '/api/orchestrator/connect', { profile: 'does-not-exist', path: 'COMX' })
    assert(status >= 400, `expected error status, got ${status}`)
    assert(String(payload.error).includes('Unknown Orchestrator profile'), `error text: ${payload.error}`)
  })

  await check('orchestrator/run and orchestrator/smoke require an attached session', async () => {
    for (const path of ['/api/orchestrator/run', '/api/orchestrator/smoke']) {
      const { status, payload } = await req(base, 'POST', path, { name: 'read_value' })
      assert(status === 409, `${path} expected 409, got ${status}`)
      assert(String(payload.error).includes('No Orchestrator session'), `${path} error: ${payload.error}`)
    }
  })

  await check('/api/capture requires a connection (409)', async () => {
    const { status, payload } = await req(base, 'POST', '/api/capture', {
      timeoutMs: 100, stop: { frames: 1 }
    })
    assert(status === 409, `expected 409, got ${status}`)
    assert(String(payload.error).includes('Not connected'), `error text: ${payload.error}`)
  })

  await check('unknown orchestrator subpath returns 404', async () => {
    const { status } = await req(base, 'GET', '/api/orchestrator/nonexistent')
    assert(status === 404, `expected 404, got ${status}`)
  })
} finally {
  child.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 300))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  if (stderr) console.error(`uartd stderr:\n${stderr.slice(-600)}`)
  process.exit(1)
}
console.log('\n=== Orchestrator Rust HTTP tests done ===')
