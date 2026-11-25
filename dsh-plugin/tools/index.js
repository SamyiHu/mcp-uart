/**
 * Agent tools — their own plugin row.
 *
 * Being a separate row means the plugin page shows a real switch for the tools,
 * next to the panel row and the optional MCP row. It also makes the fallback
 * rule expressible: when MCP tools are present this row stays silent, so the
 * two surfaces never fight over the model's attention.
 *
 * Coordination with the panel row is a single file: `~/.mcp-uart/agent.json`.
 * The panel's settings switch writes it; this row watches it (a light poll) and
 * registers or unregisters the three tools accordingly.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createAgentTools } from './agent-tools.js'

const AGENT_PREF_FILE = join(homedir(), '.mcp-uart', 'agent.json')
const HUB_FILE = join(homedir(), '.mcp-uart', 'hub.json')
const POLL_MS = 2500

/** Names the MCP bridge registers for this server; any of them means "MCP is on". */
const MCP_PREFIX = 'mcp__uart__'

async function readAgentPref() {
  try {
    const parsed = JSON.parse(await readFile(AGENT_PREF_FILE, 'utf8'))
    return parsed?.enabled !== false
  } catch {
    return true
  }
}

/** The panel row publishes the Hub address it started; fall back to the default. */
async function readHubUrl(fallback) {
  try {
    const parsed = JSON.parse(await readFile(HUB_FILE, 'utf8'))
    if (typeof parsed?.url === 'string' && parsed.url.length > 0) return parsed.url
  } catch {
    /* not started yet */
  }
  return fallback
}

/** Display name for the plugin inventory row. */
export const name = 'uart-tools'

export function apply(ctx, config) {
  const state = {
    disposers: [],
    tools: null,
    /** null until measured; then 'native' | 'mcp' | 'off' */
    mode: null,
    /** Hub address the tools call; refreshed from hub.json on every sync. */
    hubUrl: null,
  }

  const registeredCount = () => state.disposers.length

  /** Does the registry currently hold MCP tools for this server? */
  const mcpPresent = () => {
    const tools = state.tools
    if (typeof tools?.definitions !== 'function') return false
    try {
      return tools.definitions().some((definition) => String(definition?.name ?? '').startsWith(MCP_PREFIX))
    } catch {
      return false
    }
  }

  const unregister = () => {
    for (const dispose of state.disposers.splice(0)) {
      try { dispose() } catch { /* already gone */ }
    }
  }

  const register = () => {
    if (state.disposers.length > 0) return
    // Pass an accessor, not a snapshot: the Hub may restart on another port and
    // the tools must follow it without being re-registered.
    for (const definition of createAgentTools(() => state.hubUrl)) {
      try {
        const dispose = state.tools.register(definition)
        state.disposers.push(typeof dispose === 'function' ? dispose : () => {})
      } catch (error) {
        ctx.logger?.('dsh-uart')?.warn?.(`agent tool ${definition.name} not registered: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Decide which surface owns the model's tool list.
   *
   * MCP wins when both are available: the user enables the MCP row explicitly
   * as a fallback, so honouring it avoids duplicate `uart_*` and `mcp__uart__*`
   * entries describing the same serial port.
   */
  const sync = async (fallbackUrl) => {
    if (state.tools === null) return
    const wanted = config?.enabled === false ? false : await readAgentPref()
    const mcp = mcpPresent()

    if (!wanted) {
      if (state.mode !== 'off') {
        unregister()
        state.mode = 'off'
      }
      return
    }
    if (mcp) {
      // MCP fallback active: stay out of the way.
      if (state.mode !== 'mcp') {
        unregister()
        state.mode = 'mcp'
      }
      return
    }
    state.hubUrl = await readHubUrl(fallbackUrl)
    if (state.mode !== 'native') {
      register()
      state.mode = 'native'
    }
  }

  // The panel row owns the Hub; it publishes the address in hub.json, so this
  // row never has to guess a shifted port.
  const fallbackUrl = config?.hubUrl ?? 'http://127.0.0.1:8787'

  ctx.inject(['tools'], (toolCtx) => {
    state.tools = toolCtx.get('tools') ?? toolCtx.tools

    toolCtx.effect(() => {
      let stopped = false
      sync(fallbackUrl)
      const timer = setInterval(() => { if (!stopped) sync(fallbackUrl) }, POLL_MS)
      timer.unref?.()
      return () => {
        stopped = true
        clearInterval(timer)
        unregister()
      }
    }, 'dsh-uart: agent tools')
  })

  /** Read-only view of which surface won, for diagnostics and tests. */
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => () => {}, 'dsh-uart: tools marker')
  })
}

export const internals = { AGENT_PREF_FILE, MCP_PREFIX, POLL_MS, readAgentPref }
