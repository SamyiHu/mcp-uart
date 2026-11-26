#!/usr/bin/env node
/** Web Hub entry: native Rust daemon (was Node dist/hub.js). */
import { spawn } from 'node:child_process'
import { resolveUartd } from '../scripts/ensure-uartd.mjs'

const bin = resolveUartd()
// Forward user args (e.g. --port 8787) to `uartd hub`.
const child = spawn(bin, ['hub', ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
