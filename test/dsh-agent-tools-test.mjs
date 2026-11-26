/**
 * Offline checks for the DSH-native agent tools and the bundle patch.
 *
 * These run without DSH: they only assert the shape of what we ship — three
 * grouped tools with the documented actions, a patch that no longer mounts an
 * MCP row, and a hub-host that owns its child process.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentTools } from '../dsh-plugin/tools/agent-tools.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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

const tools = createAgentTools(() => 'http://127.0.0.1:9/')
const byName = new Map(tools.map((tool) => [tool.name, tool]))

await check('exposes exactly three grouped tools', () => {
  assert(tools.length === 3, `expected 3 tools, got ${tools.length}`)
  for (const name of ['uart_serial', 'uart_orchestrator', 'uart_view']) {
    assert(byName.has(name), `missing tool ${name}`)
  }
})

await check('every tool declares an action enum and an output schema', () => {
  for (const tool of tools) {
    const action = tool.parameters?.properties?.action
    assert(action?.type === 'string', `${tool.name}: action must be a string`)
    assert(Array.isArray(action.enum) && action.enum.length > 0, `${tool.name}: action enum missing`)
    assert(tool.output?.schema?.required?.includes('text'), `${tool.name}: output text required`)
    assert(typeof tool.execute === 'function', `${tool.name}: execute missing`)
  }
})

await check('serial tool covers the operational actions', () => {
  const actions = byName.get('uart_serial').parameters.properties.action.enum
  for (const action of ['list_ports', 'open', 'close', 'write', 'read', 'status', 'set_signals', 'configure']) {
    assert(actions.includes(action), `uart_serial is missing action ${action}`)
  }
})

await check('orchestrator tool covers the profile actions', () => {
  const actions = byName.get('uart_orchestrator').parameters.properties.action.enum
  for (const action of ['list', 'connect', 'disconnect', 'run', 'smoke', 'status']) {
    assert(actions.includes(action), `uart_orchestrator is missing action ${action}`)
  }
})

await check('view tool exposes the read-only surface', () => {
  const actions = byName.get('uart_view').parameters.properties.action.enum
  for (const action of ['panel', 'frames', 'history', 'ports']) {
    assert(actions.includes(action), `uart_view is missing action ${action}`)
  }
})

await check('an unknown action is rejected instead of silently succeeding', async () => {
  let threw = false
  try {
    await byName.get('uart_serial').execute({ action: 'nope' })
  } catch {
    threw = true
  }
  assert(threw, 'unknown action must throw')
})

await check('a dead hub surfaces as an error, not a fake success', async () => {
  let threw = false
  try {
    await byName.get('uart_view').execute({ action: 'panel' })
  } catch {
    threw = true
  }
  assert(threw, 'unreachable hub must throw')
})

await check('the hub address may be a plain string, not only an accessor', async () => {
  // Regression: passing a string used to make every tool call fail with
  // "hubUrl is not a function" while registration looked healthy.
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, seq: 0, frames: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`

  const stringTools = createAgentTools(url)
  const result = await stringTools.find((t) => t.name === 'uart_view').execute({ action: 'frames', limit: 5 })
  assert(result?.text === 'No frames buffered.', `string hub address must work (got ${JSON.stringify(result)})`)

  await new Promise((resolve) => server.close(resolve))
})

await check('bundle mounts one row, embeds the tools, and has no MCP row', async () => {
  const patch = await readFile(join(root, 'dsh-plugin', 'cordis.patch.yml'), 'utf8')
  const host = await readFile(join(root, 'dsh-plugin', 'index.js'), 'utf8')
  assert(!/dsh-mcp-client/.test(patch), 'patch must not mount an MCP client row')
  assert(/name: '@local\/dsh-uart'/.test(patch), 'bundle must mount the panel plugin')
  // A second row inside the same bundle has no display title in the plugin page
  // (it renders as a file URL), so the tools are mounted as a child instead.
  assert(/name: '@local\/dsh-uart\/tools'/.test(patch), 'tools must be its own subpath row')
  assert(!/applyAgentTools/.test(host), 'panel plugin must not mount the tools itself (they are a separate row)')
})

await check('host half owns the hub child process and the agent switch', async () => {
  const host = await readFile(join(root, 'dsh-plugin', 'index.js'), 'utf8')
  assert(/from '\.\/hub-host\.js'/.test(host), 'index.js must import hub-host')
  assert(host.includes('/agent'), 'host must expose the /uart/agent switch route')
  assert(!/createAgentTools/.test(host), 'tool registration belongs to the tools row, not the panel row')
})

await check('tools row yields to MCP when both are present', async () => {
  const source = await readFile(join(root, 'dsh-plugin', 'tools', 'index.js'), 'utf8')
  assert(source.includes("mcp__uart__"), 'tools row must detect the MCP tool prefix')
  assert(/unregister\(\)/.test(source), 'tools row must be able to withdraw its tools')
  assert(source.includes('readHubUrl'), 'tools row must read the published hub address')
  assert(/state\.mode = 'mcp'/.test(source), 'tools row must record the MCP-wins mode')
})

await check('hub-host spawns dist/hub.js and drains stderr', async () => {
  const source = await readFile(join(root, 'dsh-plugin', 'hub-host.js'), 'utf8')
  assert(source.includes("'dist', 'hub.js'"), 'hub-host must point at dist/hub.js')
  assert(source.includes('HUB_URL='), 'hub-host must parse the HUB_URL marker')
  assert(source.includes('keepDraining'), 'hub-host must keep draining stderr')
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n=== DSH agent tool tests done ===')
