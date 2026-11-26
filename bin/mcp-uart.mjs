#!/usr/bin/env node
/** MCP/UART entry: native Rust daemon (was Node dist/index.js). */
import { spawn } from 'node:child_process'
import { resolveUartd } from '../scripts/ensure-uartd.mjs'

const bin = resolveUartd()
const child = spawn(bin, ['stdio'], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
