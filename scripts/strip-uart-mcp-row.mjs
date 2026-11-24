/**
 * One-shot migration: remove the hand-written `mcp-uart` row from a profile
 * patch, because the UART bundle now declares its own MCP row.
 *
 *   node scripts/strip-uart-mcp-row.mjs <profile cordis.patch.yml>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/strip-uart-mcp-row.mjs <cordis.patch.yml>')
  process.exit(1)
}

const lines = readFileSync(path, 'utf8').split(/\r?\n/)
const index = lines.findIndex((line) => /id:\s*["']?mcp-uart["']?\s*$/.test(line))
if (index < 0) {
  console.error('row not found; nothing to do')
  process.exit(2)
}

let start = index
while (start > 0 && !lines[start].trimStart().startsWith('- insert:')) start -= 1

let end = index
while (end + 1 < lines.length && !lines[end + 1].trimStart().startsWith('- insert:')) end += 1

// Also drop the blank line that separated the two insert blocks.
let stop = end
if ((lines[stop] ?? '').trim() === '') stop += 1
if ((lines[stop] ?? '').trim() === '') stop += 1

const removed = lines.slice(start, stop)
lines.splice(start, stop - start)
writeFileSync(path, lines.join('\n'))
console.log(`removed ${removed.length} lines (${start + 1}..${stop})`)
