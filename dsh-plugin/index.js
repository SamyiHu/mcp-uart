/**
 * UART panel — Host half.
 *
 * Owns the whole stack for DSH:
 *   1. starts the local Hub (`dist/hub.js`) as a child process on activation and
 *      stops it when the plugin unloads;
 *   2. proxies the browser panel to that Hub under `/uart`, SSE included;
 *   3. registers the DSH-only agent tools (`uart_serial` / `uart_dut` /
 *      `uart_view`) — three grouped tools instead of the MCP server's 28;
 *   4. exposes `/uart/agent` so the settings page can switch those tools on/off.
 *
 * External users are unaffected: they run `node dist/index.js` (or `mcp-uart`)
 * against any MCP client and get the full 28-tool surface. This plugin never
 * mounts the MCP client row, so DSH sessions see no `mcp__uart__*` tools at all.
 *
 * `config.externalHub: true` opts out of owning the Hub and instead discovers a
 * Hub started elsewhere (`~/.mcp-uart/hub.json`, then ports 8787..8817) — handy
 * when debugging the panel against an MCP server's Hub.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { startHub } from './hub-host.js'
// The agent tools live in ./tools and are mounted as a child of this plugin:
// DSH has no display title for a second row inside one bundle, so a separate
// row would render as a raw file URL in the plugin page.

const ROUTE_PREFIX = '/uart'
const DEFAULT_HUB_FILE = join(homedir(), '.mcp-uart', 'hub.json')
const AGENT_PREF_FILE = join(homedir(), '.mcp-uart', 'agent.json')
const PROBE_FIRST_PORT = 8787
const PROBE_SPAN = 30
const PROBE_TIMEOUT_MS = 700

/** Resolved Hub address for the external-Hub mode; refreshed lazily. */
const discoveryCache = { url: null, at: 0 }
const RESOLVE_TTL_MS = 3000

function hubFile(config) {
  const configured = config?.hubFile
  if (typeof configured === 'string' && configured.length > 0) return configured
  const env = process.env.UART_HUB_FILE
  return typeof env === 'string' && env.length > 0 ? env : DEFAULT_HUB_FILE
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function health(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const target = new URL('api/health', url.endsWith('/') ? url : `${url}/`)
    const response = await fetch(target, { signal: controller.signal })
    if (!response.ok) return null
    const payload = await response.json()
    return payload?.ok === true ? payload : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function readAdvertisement(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return typeof parsed?.url === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Find a Hub this plugin does not own (external-Hub mode).
 *
 * Ports are probed in parallel and the NEWEST responder wins: an orphaned MCP
 * server from an earlier run keeps answering on 8787, and "first port that
 * replies" once wired the panel to a stale process whose code had no
 * /api/history.
 */
async function resolveExternalHub(config, options = {}) {
  const fresh = options.fresh === true
  const now = Date.now()
  if (!fresh && discoveryCache.url !== null && now - discoveryCache.at < RESOLVE_TTL_MS) return discoveryCache.url

  const advertisement = await readAdvertisement(hubFile(config))
  if (advertisement !== null && alive(advertisement.pid) && (await health(advertisement.url)) !== null) {
    discoveryCache.url = advertisement.url
    discoveryCache.at = now
    return advertisement.url
  }

  const candidates = await Promise.all(
    Array.from({ length: PROBE_SPAN + 1 }, async (_, offset) => {
      const url = `http://127.0.0.1:${PROBE_FIRST_PORT + offset}`
      const state = await health(url)
      return state === null ? null : { url, startedAt: state.startedAt ?? '', pid: state.pid ?? 0 }
    }),
  )
  const live = candidates.filter((entry) => entry !== null)
  if (live.length > 0) {
    live.sort((left, right) => {
      const byTime = String(right.startedAt).localeCompare(String(left.startedAt))
      return byTime !== 0 ? byTime : right.pid - left.pid
    })
    discoveryCache.url = live[0].url
    discoveryCache.at = now
    return live[0].url
  }

  discoveryCache.url = null
  discoveryCache.at = now
  return null
}

function json(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Answer with the host's own rejection when it has one (browser login / untrusted origin). */
function refuseUnadmitted(ctx, request, response) {
  const connection = ctx.get('connection')
  const gate = connection?.requestRejection
  if (typeof gate !== 'function') return false
  let status
  try {
    status = gate.call(connection, request)
  } catch {
    status = 403
  }
  if (status === undefined) return false
  json(response, status, { ok: false, error: 'This DSH request was not admitted.' })
  return true
}

/** Stream one request to the Hub; headers, status code and SSE chunks pass through unchanged. */
function proxy(hubUrl, request, response) {
  const incoming = new URL(request.url ?? '/', 'http://localhost')
  const rest = incoming.pathname.startsWith(ROUTE_PREFIX)
    ? incoming.pathname.slice(ROUTE_PREFIX.length)
    : incoming.pathname
  const target = new URL(`${rest.startsWith('/') ? rest : `/${rest}`}${incoming.search}`, hubUrl)

  const headers = { ...request.headers, host: target.host }
  const upstream = http.request(target, { method: request.method, headers }, (answer) => {
    const out = { ...answer.headers }
    delete out['content-length']
    response.writeHead(answer.statusCode ?? 502, out)
    answer.pipe(response)
  })

  upstream.on('error', (error) => {
    if (response.headersSent) {
      response.destroy()
      return
    }
    json(response, 502, {
      ok: false,
      error: `UART hub at ${hubUrl} did not answer: ${error?.message ?? String(error)}`,
    })
  })

  response.on('close', () => upstream.destroy())
  request.pipe(upstream)
}

/** Agent-tool preference: default ON, persisted next to the Hub discovery file. */
async function readAgentPref() {
  try {
    const parsed = JSON.parse(await readFile(AGENT_PREF_FILE, 'utf8'))
    return parsed?.enabled !== false
  } catch {
    return true
  }
}

async function writeAgentPref(enabled) {
  await mkdir(dirname(AGENT_PREF_FILE), { recursive: true })
  await writeFile(AGENT_PREF_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

/** Publish the Hub address for the tools row (and any external consumer). */
async function publishHubFile(url) {
  await mkdir(dirname(DEFAULT_HUB_FILE), { recursive: true })
  await writeFile(
    DEFAULT_HUB_FILE,
    `${JSON.stringify({ url, port: Number(new URL(url).port || 0), pid: process.pid, startedAt: new Date().toISOString(), hub: 'dsh-plugin' }, null, 2)}\n`,
    'utf8',
  )
}

export function apply(ctx, config) {
  const state = {
    url: null,
    error: null,
    dispose: null,
    enabled: true,
  }

  /** Resolves once the Hub is up (or failed); every route awaits it. */
  const ready = (async () => {
    try {
      if (config?.externalHub === true) {
        const url = await resolveExternalHub(config, { fresh: true })
        if (url === null) throw new Error(`No external UART Hub found (looked in ${hubFile(config)} and ports ${PROBE_FIRST_PORT}..${PROBE_FIRST_PORT + PROBE_SPAN})`)
        state.url = url
      } else {
        const started = await startHub({
          nodePath: config?.nodePath,
          port: Number(config?.port ?? 8787),
          portSpan: Number(config?.portSpan ?? 30),
        })
        state.url = started.url
        state.dispose = started.dispose
      }
      // Publish the address so the tools row (a separate plugin) can reach the
      // same Hub without guessing a shifted port.
      await publishHubFile(state.url).catch(() => {})
    } catch (error) {
      state.error = error?.message ?? String(error)
    }
  })()

  ctx.effect(() => () => {
    const stop = state.dispose
    state.dispose = null
    if (typeof stop === 'function') Promise.resolve().then(stop).catch(() => {})
  }, 'dsh-uart: hub')

  ctx.effect(() => {
    let cancelled = false
    // `config.agentTool: false` is a hard default from the patch; otherwise the
    // user's last choice in the settings page wins.
    if (config?.agentTool === false) {
      state.enabled = false
      writeAgentPref(false).catch(() => {})
      return () => { cancelled = true }
    }
    readAgentPref().then((enabled) => {
      if (!cancelled) state.enabled = enabled
    })
    return () => { cancelled = true }
  }, 'dsh-uart: agent pref')

  // The tool layer is its own row (`@local/dsh-uart/tools`) so the plugin page
  // can switch it independently; it is not mounted here, or the tools would
  // register twice.

  ctx.inject(['webServer'], (hostCtx) => {
    const handler = async (request, response) => {
      if (refuseUnadmitted(ctx, request, response)) return
      await ready
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname

      // Panel chrome needs two addresses the page itself cannot derive: the Hub
      // origin to open in a real browser, and this host's own origin (the page
      // runs on the dsh-app:// scheme, where neither is visible).
      if (pathname === `${ROUTE_PREFIX}/api/panel`) {
        let origin = null
        try {
          origin = hostCtx.webServer.getOrigin()
        } catch {
          origin = null
        }
        json(response, 200, {
          ok: state.error === null,
          hubUrl: state.url,
          origin,
          panelUrl: origin === null ? null : `${origin}${ROUTE_PREFIX}/`,
          error: state.error,
        })
        return
      }

      // Agent-tool switch, used by the settings page.
      if (pathname === `${ROUTE_PREFIX}/agent`) {
        if (request.method === 'POST') {
          let body = {}
          try {
            const chunks = []
            for await (const chunk of request) chunks.push(chunk)
            if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            json(response, 400, { ok: false, error: 'Invalid JSON body' })
            return
          }
          const enabled = body?.enabled !== false
          state.enabled = enabled
          // The tools row watches this file, so the switch takes effect without
          // this plugin registering anything itself.
          await writeAgentPref(enabled).catch(() => {})
          json(response, 200, { ok: true, enabled })
          return
        }
        json(response, 200, { ok: true, enabled: state.enabled })
        return
      }

      // Diagnostics: which surface currently owns the model's tool list?
      if (pathname === `${ROUTE_PREFIX}/tools`) {
        const tools = ctx.get('tools')
        const names = ['uart_serial', 'uart_dut', 'uart_view']
        const definitions = typeof tools?.definitions === 'function' ? tools.definitions() : []
        const mcpTools = definitions.filter((definition) => String(definition?.name ?? '').startsWith('mcp__uart__'))
        const nativeTools = names.filter((name) => typeof tools?.get === 'function' && Boolean(tools.get(name)))
        json(response, 200, {
          ok: true,
          enabled: state.enabled,
          hubUrl: state.url,
          hubError: state.error,
          // Native wins unless MCP is the only surface present; the tools row
          // yields whenever MCP tools exist, so this line mirrors its decision.
          mode: mcpTools.length > 0 ? 'mcp' : nativeTools.length > 0 ? 'native' : 'off',
          tools: names.map((name) => ({ name, present: nativeTools.includes(name) })),
          mcpTools: mcpTools.map((definition) => definition.name),
        })
        return
      }

      if (state.url === null) {
        json(response, 503, {
          ok: false,
          error: state.error ?? 'UART hub is not running',
          hint: 'Run "npm run build" so dist/hub.js exists, or set config.externalHub to attach to a Hub you started.',
        })
        return
      }
      proxy(state.url, request, response)
    }

    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-uart: /uart proxy',
    )
  })
}

/** Offline verification hooks. */
export const internals = {
  proxyPath: (u) => u,
  hubFile,
  resolveExternalHub,
  ROUTE_PREFIX,
  AGENT_PREF_FILE,
}
