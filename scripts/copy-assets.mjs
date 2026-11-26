#!/usr/bin/env node
/**
 * Copy runtime assets into dist/.
 *
 * The target directories are CLEARED first: `tsc` does not remove files whose
 * source disappeared, so a deleted profile (or renamed asset) would otherwise
 * keep shipping in the package. That is exactly how two device-specific
 * profiles survived a desensitisation pass.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const copies = [
  // Compiled output lives in the same folder (index.js), so only the data files
  // are cleared — wiping the directory would delete tsc's own output.
  {
    from: join(root, 'src', 'orchestrator', 'profiles'),
    to: join(root, 'dist', 'orchestrator', 'profiles'),
    filter: (src) => !src.endsWith('.ts'),
    clean: (name) => name.endsWith('.json'),
  },
  {
    from: join(root, 'src', 'hub', 'public'),
    to: join(root, 'dist', 'hub', 'public'),
    filter: undefined,
    clean: () => true,
  },
]

for (const { from, to, filter, clean } of copies) {
  if (!existsSync(from)) continue
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(to)) {
    if (clean(name)) rmSync(join(to, name), { recursive: true, force: true })
  }
  cpSync(from, to, { recursive: true, ...(filter ? { filter } : {}) })
  console.log(`copied ${from.replace(root + '\\', '')} -> ${to.replace(root + '\\', '')}`)
}
