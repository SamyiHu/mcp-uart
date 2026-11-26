#!/usr/bin/env node
/**
 * Resolve the native `uartd` binary for this platform.
 *
 *   1. If a vendored prebuilt binary exists for this OS/arch → use it.
 *   2. Otherwise build from `rust/` with cargo → use target/release/uartd.
 *
 * Prints the absolute path to stdout; nothing else. Used by the npm bin
 * wrappers and by `npm install` (prebuild step).
 */
import { existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const key = `${process.platform}-${process.arch}`
const VENDORED = {
  'win32-x64': 'bin/win32-x64/uartd.exe',
  'linux-x64': 'bin/linux-x64/uartd',
  'darwin-x64': 'bin/darwin-x64/uartd',
  'darwin-arm64': 'bin/darwin-arm64/uartd',
}
const suffix = process.platform === 'win32' ? '.exe' : ''

export function resolveUartd() {
  const vendored = VENDORED[key]
  if (vendored) {
    const p = join(ROOT, vendored)
    if (existsSync(p)) {
      if (process.platform !== 'win32') chmodSync(p, 0o755)
      return p
    }
  }
  // Fall back: build from source with cargo.
  const target = join(ROOT, 'rust', 'target')
  const built = join(target, 'release', `uartd${suffix}`)
  if (existsSync(built)) return built

  const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  mkdirSync(target, { recursive: true })
  const result = spawnSync(cargo, ['build', '--release', '--manifest-path', join(ROOT, 'rust', 'Cargo.toml')], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: target },
    stdio: 'inherit',
  })
  if (result.status !== 0 || !existsSync(built)) {
    throw new Error(`failed to build uartd with cargo (exit ${result.status}); install Rust or provide a prebuilt binary for ${key}`)
  }
  return built
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(resolveUartd() + '\n')
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
}
