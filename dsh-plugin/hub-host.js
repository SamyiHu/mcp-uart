/**
 * Hub lifecycle for the DSH Host plugin.
 *
 * The panel and the agent tools both talk to one local Hub. In DSH we own that
 * Hub: `dist/hub.js` (the same entry `npx mcp-uart-hub` runs) is started as a
 * child process and stopped with the plugin.
 *
 * Why a child process and not an in-process import: the Hub loads
 * `@serialport/bindings-cpp`. Those bindings are NAPI-8 (ABI-stable), but a
 * load failure inside the host process would take the whole plugin down with
 * it — panel included. A child isolates that: a Hub crash leaves the plugin
 * alive and able to explain what happened.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const NODE_HUB_ENTRY = join(REPO_ROOT, 'dist', 'hub.js')
const RUST_HUB_ENTRY = join(REPO_ROOT, 'rust', 'target', 'release', 'uartd.exe')
const RUST_HUB_ENTRY_ALT = 'E:\\cargo-target\\uartd\\release\\uartd.exe'

/** Pick the Rust daemon when present, otherwise the Node Hub. */
function hubEntry() {
  if (existsSync(RUST_HUB_ENTRY)) return { executable: RUST_HUB_ENTRY, rust: true }
  if (existsSync(RUST_HUB_ENTRY_ALT)) return { executable: RUST_HUB_ENTRY_ALT, rust: true }
  return { executable: NODE_HUB_ENTRY, rust: false }
}

/** How long to wait for the child to print HUB_URL= before giving up. */
const READY_TIMEOUT_MS = 15000

/**
 * Start `dist/hub.js` and resolve once it reports its URL.
 *
 * @param {object} options
 * @param {string} [options.nodePath]  override the Node executable
 * @param {number} [options.port]      preferred port (default 8787)
 * @param {number} [options.portSpan]  fallback span (default 30)
 * @returns {Promise<{ url: string, port: number, pid: number, dispose: () => Promise<void> }>}
 */
export async function startHub(options = {}) {
  const { executable, rust } = hubEntry()
  if (!existsSync(executable)) {
    throw new Error(`UART Hub entry not found at ${executable}; run "npm run build" first`)
  }

  const nodePath = typeof options.nodePath === 'string' && options.nodePath.length > 0
    ? options.nodePath
    : process.execPath
  // The Rust daemon is a native exe; args differ from the Node entry.
  const port = String(options.port ?? 8787)
  const span = String(options.portSpan ?? 30)
  const env = { ...process.env }
  if (!rust && /DeepSeek Harness\.exe$/i.test(nodePath)) env.ELECTRON_RUN_AS_NODE = '1'

  const child = rust
    ? spawn(executable, ['hub', '--host', '127.0.0.1', '--port', port, '--port-span', span],
        { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(nodePath, [executable, '--port', port, '--port-span', span],
        { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })

  // Keep draining stderr after startup: if nobody reads it the OS pipe buffer
  // fills at 64 KB and the child blocks on its next write.
  let tail = ''
  const keepDraining = (chunk) => {
    tail = (tail + String(chunk)).slice(-2000)
  }

  const url = await waitForUrl(child, READY_TIMEOUT_MS, port, span).catch(async (error) => {
    await stop(child)
    throw error
  })

  child.stderr?.on('data', keepDraining)
  child.stdout?.resume()

  let stopped = false
  let exitInfo = null
  child.once('exit', (code, signal) => { exitInfo = { code, signal } })

  const dispose = async () => {
    if (stopped) return
    stopped = true
    await stop(child)
  }

  return {
    url,
    port: Number(new URL(url).port || 0),
    pid: child.pid ?? 0,
    dispose,
    /** Why the child left, once it has (null while running). */
    exitInfo: () => exitInfo,
    /** Last 2 KB of the child's stderr, for diagnostics. */
    stderrTail: () => tail,
  }
}

/**
 * Wait for the Hub to become reachable.
 *
 * Primary signal is the HUB_URL= line on stderr. Some hosts (Electron's node
 * seam, locked-down environments) swallow the child's stderr pipes, so also
 * poll /api/health on the preferred port range as a fallback.
 */
function waitForUrl(child, timeoutMs, preferredPort, span) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let buffer = ''

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }

    const onData = (chunk) => {
      buffer += String(chunk)
      const match = buffer.match(/HUB_URL=(\S+)/)
      if (match) finish(null, match[1].trim())
      else if (/Hub fatal:/.test(buffer)) finish(new Error(buffer.trim().split('\n').pop() ?? 'Hub failed to start'))
    }
    const onExit = (code) => finish(new Error(`UART Hub exited early (code ${code}); stderr: ${buffer.trim().slice(-400)}`))
    const onError = (error) => finish(new Error(`UART Hub could not start: ${error?.message ?? error}`))

    // Poll the port range for a healthy Hub. Any responder wins; the child owns
    // exactly one of these ports, so this is safe even when stderr is lost.
    const poll = setInterval(async () => {
      const first = Number(preferredPort ?? 8787)
      const last = first + Number(span ?? 30)
      for (let p = first; p <= last; p += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(300) })
          if (!response.ok) continue
          const data = await response.json()
          if (data?.ok === true) {
            finish(null, `http://127.0.0.1:${p}`)
            return
          }
        } catch { /* not listening yet */ }
      }
    }, 250)

    const timer = setTimeout(
      () => finish(new Error(`UART Hub did not become ready within ${timeoutMs}ms; stderr: ${buffer.trim().slice(-400)}`)),
      timeoutMs,
    )
    timer.unref?.()

    child.stderr?.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

/** SIGTERM, then SIGKILL if it refuses to leave. */
function stop(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise()
      return
    }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolvePromise()
    }, 3000)
    killTimer.unref?.()
    child.once('exit', () => {
      clearTimeout(killTimer)
      resolvePromise()
    })
    try { child.kill('SIGTERM') } catch { clearTimeout(killTimer); resolvePromise() }
  })
}
