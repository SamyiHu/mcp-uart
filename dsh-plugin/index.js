/**
 * UART panel — Host half.
 *
 * The MCP server (`mcp-uart`) already runs the serial stack: one SerialManager
 * shared by the MCP tools and an in-process HTTP Hub. This plugin does not open
 * a second one. It finds that Hub and mounts it under `/uart` on the DSH web
 * server, so the browser panel and the Agent talk to the SAME serial session.
 *
 * Discovery order:
 *   1. `~/.mcp-uart/hub.json` (written by the MCP server, override with
 *      UART_HUB_FILE or the row config `hubFile`)
 *   2. A health probe of http://127.0.0.1:8787..8817 (the Hub's default span)
 *
 * Routes (same-origin, behind the host connection gate):
 *   ANY /uart/*  → transparent proxy to the Hub, including the SSE stream
 *
 * Without DSH nothing here is involved: `mcp-uart-hub` (or the MCP server
 * itself) serves the same API and the same browser UI on its own port.
 */
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROUTE_PREFIX = '/uart'
const DEFAULT_HUB_FILE = join(homedir(), '.mcp-uart', 'hub.json')
const PROBE_FIRST_PORT = 8787
const PROBE_SPAN = 30
const RESOLVE_TTL_MS = 3000
const PROBE_TIMEOUT_MS = 700

/** Resolved Hub address, refreshed lazily so a restarted MCP server is picked up. */
const cache = { url: null, at: 0 }

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

/** The Hub URL plus why we trust it, or null when no Hub is running. */
async function resolveHub(config, options = {}) {
  const fresh = options.fresh === true
  const now = Date.now()
  if (!fresh && cache.url !== null && now - cache.at < RESOLVE_TTL_MS) return cache.url

  const advertisement = await readAdvertisement(hubFile(config))
  if (advertisement !== null && alive(advertisement.pid) && (await health(advertisement.url)) !== null) {
    cache.url = advertisement.url
    cache.at = now
    return advertisement.url
  }

  // Probe every port and keep the NEWEST responder.
  //
  // An orphaned MCP server from an earlier run keeps listening on 8787 and
  // answers happily, so "first port that replies" once wired the panel to a
  // three-day-old process whose code had no /api/history. Sorting by the
  // process start time the Hub reports avoids that.
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
    cache.url = live[0].url
    cache.at = now
    return live[0].url
  }

  cache.url = null
  cache.at = now
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

/** Cheap agent-facing probe: is the serial stack up, and what is it attached to? */
function registerAgentTool(ctx, config) {
  const tools = ctx.get('tools')
  if (typeof tools?.register !== 'function') return undefined
  return tools.register({
    name: 'uart_panel_status',
    description:
      'Report the UART panel backend: whether the serial Hub is running, its local URL, and the active connection. The panel itself opens from the sidebar; this tool only diagnoses why it may be empty.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute() {
      const url = await resolveHub(config, { fresh: true })
      if (url === null) {
        return {
          text: [
            'UART hub: not running.',
            `Discovery file: ${hubFile(config)} (absent, stale, or unreachable).`,
            'Start it with the mcp-uart MCP server, or run: npx mcp-uart-hub',
          ].join('\n'),
        }
      }
      const state = await health(url)
      return {
        text: [
          `UART hub: ${url}`,
          `panel route: ${ROUTE_PREFIX}/`,
          `active connection: ${state?.activeConnectionId ?? '(none)'}`,
          `owned by hub: ${state?.ownsPort === true ? 'yes' : 'no (attached to the MCP session)'}`,
          `frames buffered: ${state?.frameCount ?? 0}`,
        ].join('\n'),
      }
    },
  })
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const dispose = registerAgentTool(ctx, config)
    return typeof dispose === 'function' ? dispose : () => {}
  }, 'dsh-uart: agent tool')

  ctx.inject(['webServer'], (hostCtx) => {
    const handler = async (request, response) => {
      if (refuseUnadmitted(ctx, request, response)) return
      const url = await resolveHub(config)
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
          ok: true,
          hubUrl: url,
          origin,
          panelUrl: origin === null ? null : `${origin}${ROUTE_PREFIX}/`,
        })
        return
      }

      if (url === null) {
        json(response, 503, {
          ok: false,
          error: 'UART hub is not running',
          hint: 'Start the mcp-uart MCP server (it hosts the Hub) or run: npx mcp-uart-hub',
          discoveryFile: hubFile(config),
        })
        return
      }
      proxy(url, request, response)
    }
    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-uart: /uart proxy',
    )
  })
}

/** Offline verification hooks. */
export const internals = { proxyPath: (u) => u, hubFile, resolveHub, ROUTE_PREFIX }
