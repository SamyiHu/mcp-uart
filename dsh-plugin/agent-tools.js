/**
 * Agent tools for DSH.
 *
 * Three grouped tools instead of 28 MCP tools. Each is one `action` enum that
 * dispatches to the Hub's HTTP API — the same endpoints the panel uses, so the
 * tool layer never re-implements serial logic and both surfaces always agree.
 *
 * Why grouped: the MCP server exposes 28 separate tools (~4.1k tokens of schema
 * in every request, with near-identical names that invite wrong picks). Grouping
 * by domain keeps the model's tool list small and unambiguous. External users on
 * other clients still get the full 28 through the MCP server — unchanged.
 */

const TIMEOUT_MS = 60000

/** Call the Hub; returns the parsed JSON body or throws with the Hub's message. */
async function callHub(hubUrl, path, init = {}) {
  if (!hubUrl) throw new Error('UART Hub is not running')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS)
  try {
    const response = await fetch(new URL(path, hubUrl.endsWith('/') ? hubUrl : `${hubUrl}/`), {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload
    try {
      payload = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      payload = { ok: response.ok, text }
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `Hub responded ${response.status}`)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

function text(value) {
  return { text: value }
}

const serialParameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list_ports', 'open', 'close', 'write', 'read', 'status', 'set_signals', 'configure'],
      description:
        'list_ports: serial ports on this machine. open: connect (path + baudRate). close: disconnect. '
        + 'write: send data (accepts \\n, \\r\\n or HEX with encoding "hex"). read: recent frames. '
        + 'status: current connection. set_signals: pulse break / set DTR or RTS. configure: change '
        + 'encoding or framing on the live connection.',
    },
    path: { type: 'string', description: 'Serial port, e.g. COM6 or /dev/ttyUSB0 (action=open).' },
    baudRate: { type: 'integer', description: 'Baud rate (action=open), default 115200.' },
    data: { type: 'string', description: 'Payload to send (action=write).' },
    encoding: { type: 'string', description: 'utf8 | gbk | gb18030 | big5 | shift_jis | euc-kr | latin1 | hex | base64.' },
    protocol: { type: 'string', enum: ['line', 'raw', 'delimiter', 'modbus-rtu', 'hex-frame', 'slip'], description: 'Framing rule (action=open/configure).' },
    count: { type: 'integer', description: 'How many recent frames to return (action=read), default 50.' },
    direction: { type: 'string', enum: ['all', 'rx', 'tx'], description: 'Frame filter (action=read).' },
    dtr: { type: 'boolean', description: 'DTR level (action=set_signals).' },
    rts: { type: 'boolean', description: 'RTS level (action=set_signals).' },
    break: { type: 'boolean', description: 'Pulse BREAK (action=set_signals).' },
  },
  required: ['action'],
  additionalProperties: false,
}

const dutParameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'connect', 'disconnect', 'run', 'smoke', 'status'],
      description:
        'list: available DUT profiles and their commands. connect: open a profile (profile + optional path/baudRate). '
        + 'disconnect: end the DUT session. run: execute one command by name. smoke: run the profile smoke sequence. '
        + 'status: DUT session state.',
    },
    profile: { type: 'string', description: 'Profile name, e.g. w6729 (action=connect).' },
    path: { type: 'string', description: 'Serial port override (action=connect).' },
    baudRate: { type: 'integer', description: 'Baud rate override (action=connect).' },
    name: { type: 'string', description: 'Command name (action=run).' },
    includeLowPower: { type: 'boolean', description: 'Include low-power steps in smoke (action=smoke).' },
  },
  required: ['action'],
  additionalProperties: false,
}

const viewParameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['panel', 'frames', 'history', 'ports'],
      description:
        'panel: Hub/panel status (URL, active connection). frames: buffered frames of the live session. '
        + 'history: archived frames across reconnects, with text/hex search. ports: ports with USB ids.',
    },
    limit: { type: 'integer', description: 'Max rows to return (action=frames/history), default 50.' },
    offset: { type: 'integer', description: 'Skip rows, newest first (action=history).' },
    text: { type: 'string', description: 'Substring filter on decoded text (action=history).' },
    hex: { type: 'string', description: 'Substring filter on raw HEX (action=history).' },
    direction: { type: 'string', enum: ['all', 'rx', 'tx'] },
  },
  required: ['action'],
  additionalProperties: false,
}

/** Compact one frame for the model: no seq noise, payload kept verbatim. */
function frameLine(frame) {
  const time = String(frame?.timestamp ?? '').slice(11, 23)
  const dir = String(frame?.direction ?? '').toUpperCase()
  const body = frame?.direction === 'tx' ? frame?.raw ?? frame?.data ?? '' : frame?.data ?? frame?.raw ?? ''
  return `${time} ${dir}  ${body}`
}

/**
 * Build the three tool definitions.
 *
 * @param {() => string | null} hubUrl  current Hub URL (null when not running)
 */
export function createAgentTools(hubUrl) {
  const serial = {
    name: 'uart_serial',
    description:
      'Serial port over the DSH UART panel: list ports, open/close, send and read data, modem signals, '
      + 'and live encoding/framing changes. Uses the same session the panel shows.',
    parameters: serialParameters,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args = {}) {
      const url = hubUrl()
      switch (args.action) {
        case 'list_ports': {
          const data = await callHub(url, 'api/ports')
          const ports = Array.isArray(data.ports) ? data.ports : []
          if (ports.length === 0) return text('No serial ports found.')
          return text(ports.map((p) => [p.path, p.manufacturer, p.vendorId && p.productId ? `${p.vendorId}:${p.productId}` : ''].filter(Boolean).join('  ')).join('\n'))
        }
        case 'open': {
          if (!args.path) throw new Error('path is required for action=open')
          const body = { path: args.path, baudRate: args.baudRate ?? 115200 }
          if (args.encoding) body.encoding = args.encoding
          if (args.protocol) body.protocol = args.protocol
          const data = await callHub(url, 'api/connect', { method: 'POST', body })
          // The Hub hands over an already-open port instead of closing and
          // reopening it, so say so rather than implying a fresh open.
          return text(
            data.reused === true
              ? `attached to the open session on ${args.path} @ ${body.baudRate} (connection ${data.connectionId ?? '?'})`
              : `opened ${args.path} @ ${body.baudRate} (connection ${data.connectionId ?? '?'})`,
          )
        }
        case 'close': {
          await callHub(url, 'api/disconnect', { method: 'POST' })
          return text('connection closed')
        }
        case 'write': {
          if (typeof args.data !== 'string' || args.data.length === 0) throw new Error('data is required for action=write')
          const body = { data: args.data }
          if (args.encoding) body.encoding = args.encoding
          const data = await callHub(url, 'api/write', { method: 'POST', body })
          return text(`wrote ${data.bytesWritten ?? 0} bytes  HEX: ${data.raw ?? ''}`)
        }
        case 'read': {
          const limit = Math.max(1, Math.min(500, args.count ?? 50))
          const query = new URLSearchParams({ limit: String(limit) })
          if (args.direction) query.set('direction', args.direction)
          const data = await callHub(url, `api/frames?${query}`)
          const frames = Array.isArray(data.frames) ? data.frames : []
          if (frames.length === 0) return text('No frames buffered.')
          return text(frames.map(frameLine).join('\n'))
        }
        case 'status': {
          const data = await callHub(url, 'api/status')
          const active = data.active
          return text([
            `hub: ${url}`,
            `connected: ${active ? 'yes' : 'no'}`,
            active ? `port: ${active.config?.path} @ ${active.config?.baudRate}` : null,
            active ? `encoding: ${active.config?.encoding}  protocol: ${active.config?.protocol}` : null,
            `frames buffered: ${data.frameCount ?? 0}`,
          ].filter(Boolean).join('\n'))
        }
        case 'set_signals': {
          const body = {}
          if (typeof args.dtr === 'boolean') body.dtr = args.dtr
          if (typeof args.rts === 'boolean') body.rts = args.rts
          if (typeof args.break === 'boolean') body.break = args.break
          await callHub(url, 'api/signals', { method: 'POST', body })
          return text(`signals set: ${JSON.stringify(body)}`)
        }
        case 'configure': {
          const body = {}
          if (args.encoding) body.encoding = args.encoding
          if (args.protocol) body.protocol = args.protocol
          if (args.baudRate) body.baudRate = args.baudRate
          await callHub(url, 'api/config', { method: 'POST', body })
          return text(`reconfigured: ${JSON.stringify(body)}`)
        }
        default:
          throw new Error(`Unknown action: ${args.action}`)
      }
    },
  }

  const dut = {
    name: 'uart_dut',
    description:
      'Run the project DUT test profiles over the UART panel session: list profiles, connect one, '
      + 'execute single commands, or run the whole smoke sequence. Profiles carry their own framing and pass/fail rules.',
    parameters: dutParameters,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args = {}) {
      const url = hubUrl()
      switch (args.action) {
        case 'list': {
          const data = await callHub(url, 'api/dut')
          if (data.available === false) throw new Error('This Hub was started without a DUT manager')
          const profiles = Array.isArray(data.profiles) ? data.profiles : []
          if (profiles.length === 0) return text('No DUT profiles installed.')
          return text(profiles.map((p) => {
            const cmds = Array.isArray(p.commands) ? p.commands.map((c) => c.name).join(', ') : ''
            return `${p.name}: ${p.description ?? ''}\n  commands: ${cmds}`
          }).join('\n\n'))
        }
        case 'connect': {
          if (!args.profile) throw new Error('profile is required for action=connect')
          const body = { profile: args.profile }
          if (args.path) body.path = args.path
          if (args.baudRate) body.baudRate = args.baudRate
          const data = await callHub(url, 'api/dut/connect', { method: 'POST', body })
          return text(`DUT ${args.profile} connected${data.opened ? ' (port opened)' : ' (attached to the current port)'}`)
        }
        case 'disconnect': {
          await callHub(url, 'api/dut/disconnect', { method: 'POST', body: {} })
          return text('DUT session closed')
        }
        case 'run': {
          if (!args.name) throw new Error('name is required for action=run')
          const data = await callHub(url, 'api/dut/run', { method: 'POST', body: { name: args.name } })
          const result = data.result ?? data
          const lines = [`[${result.verdict}] ${result.command ?? args.name} — ${result.title ?? ''} (${result.elapsedMs ?? 0}ms)`]
          if (Array.isArray(result.failedChecks) && result.failedChecks.length > 0) lines.push(`failed: ${result.failedChecks.join('; ')}`)
          if (Array.isArray(result.frames) && result.frames.length > 0) lines.push(`rx: ${result.frames.map((f) => f.bytes?.map((b) => b.toString(16).padStart(2, '0')).join(' ')).join(' | ')}`)
          return text(lines.join('\n'))
        }
        case 'smoke': {
          const data = await callHub(url, 'api/dut/smoke', { method: 'POST', body: { includeLowPower: args.includeLowPower === true }, timeoutMs: 300000 })
          const steps = Array.isArray(data.steps) ? data.steps : []
          const head = `PASS ${data.pass ?? 0} · FAIL ${data.fail ?? 0} · REPORT ${data.report ?? 0} (${data.elapsedMs ?? 0}ms)`
          const body = steps.map((s) => `[${s.verdict}] ${s.command} — ${s.title ?? ''} (${s.elapsedMs ?? 0}ms)`).join('\n')
          const failed = steps.filter((s) => s.verdict === 'FAIL')
          const detail = failed.length === 0
            ? ''
            : '\n\n' + failed.map((s) => `${s.command}: ${(s.failedChecks ?? []).join('; ')}`).join('\n')
          return text(`${head}\n${body}${detail}`)
        }
        case 'status': {
          const data = await callHub(url, 'api/dut/status')
          const status = data.status ?? {}
          return text([
            `profile: ${status.profile ?? '(none)'}`,
            `connected: ${status.connected === true ? 'yes' : 'no'}`,
            `busy: ${status.busy === true ? 'yes' : 'no'}`,
          ].join('\n'))
        }
        default:
          throw new Error(`Unknown action: ${args.action}`)
      }
    },
  }

  const view = {
    name: 'uart_view',
    description:
      'Read-side view of the DSH UART panel: panel/Hub status, buffered frames of the live session, '
      + 'and the archived frame history with text or HEX search.',
    parameters: viewParameters,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args = {}) {
      const url = hubUrl()
      switch (args.action) {
        case 'panel': {
          const data = await callHub(url, 'api/status')
          const active = data.active
          return text([
            `hub: ${url}`,
            `panel route: /uart/`,
            `active connection: ${active ? `${active.config?.path} @ ${active.config?.baudRate}` : '(none)'}`,
            `frames buffered: ${data.frameCount ?? 0}`,
            `connections: ${Array.isArray(data.connections) ? data.connections.length : 0}`,
          ].join('\n'))
        }
        case 'frames': {
          const limit = Math.max(1, Math.min(500, args.limit ?? 50))
          const query = new URLSearchParams({ limit: String(limit) })
          if (args.direction) query.set('direction', args.direction)
          const data = await callHub(url, `api/frames?${query}`)
          const frames = Array.isArray(data.frames) ? data.frames : []
          return text(frames.length === 0 ? 'No frames buffered.' : frames.map(frameLine).join('\n'))
        }
        case 'history': {
          const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(500, args.limit ?? 50))) })
          if (args.offset) query.set('offset', String(args.offset))
          if (args.text) query.set('text', args.text)
          if (args.hex) query.set('hex', args.hex)
          if (args.direction) query.set('direction', args.direction)
          const data = await callHub(url, `api/history?${query}`)
          const frames = Array.isArray(data.frames) ? data.frames : []
          const head = `${data.total ?? frames.length} matching rows (newest first)`
          return text(frames.length === 0 ? `${head}\n(nothing matched)` : `${head}\n${frames.map(frameLine).join('\n')}`)
        }
        case 'ports': {
          const data = await callHub(url, 'api/ports')
          const ports = Array.isArray(data.ports) ? data.ports : []
          if (ports.length === 0) return text('No serial ports found.')
          return text(ports.map((p) => JSON.stringify(p)).join('\n'))
        }
        default:
          throw new Error(`Unknown action: ${args.action}`)
      }
    },
  }

  return [serial, dut, view]
}
