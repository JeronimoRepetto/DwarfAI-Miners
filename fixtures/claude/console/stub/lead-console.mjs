#!/usr/bin/env node
// A stub "lead terminal" for the observed-subagent route's OS lane (AMENDMENT-29; 17 §1.8: processes
// under test are stubs, never provider CLIs or real terminals). Windows only. Started as
// `node lead-console.mjs <screen.txt> [maxMs]` with no shell, it runs in the hidden console every
// `windowsHide` child gets, which is the console the route attaches to by pid:
//
// - it clears its OWN console (`CONOUT$`, written through a tty stream so the text reaches the
//   screen buffer as UTF-16, glyphs intact) and draws the rows of <screen.txt>, top-left;
// - it reads its OWN console's input buffer (`CONIN$`, raw mode) and prints one `key <hex>` line per
//   chunk it receives on stdout, after `ready` once it draws and listens.
//
// It never runs a provider CLI. It exits when its stdin ends or maxMs pass (default 30000), the cap
// keeping a forgotten stub from outliving its run.
import { openSync, readFileSync } from 'node:fs'
import { ReadStream, WriteStream } from 'node:tty'

const [screenFile, maxMsText] = process.argv.slice(2)
const maxMs = Number(maxMsText ?? 30_000)
const cap = setTimeout(() => process.exit(0), Number.isFinite(maxMs) ? maxMs : 30_000)

const rows = readFileSync(screenFile, 'utf8').replace(/\n$/, '').split('\n')
// `//./CONOUT$` and `//./CONIN$`: Node resolves the bare names as relative file names.
const screen = new WriteStream(openSync('//./CONOUT$', 'r+'))
screen.write(`\u001b[2J\u001b[H${rows.join('\r\n')}`, () => {
  const input = new ReadStream(openSync('//./CONIN$', 'r+'))
  input.setRawMode(true)
  input.on('data', (chunk) => {
    process.stdout.write(`key ${Buffer.from(chunk).toString('hex')}\n`)
  })
  process.stdout.write('ready\n')
})
process.stdin.on('end', () => {
  clearTimeout(cap)
  process.exit(0)
})
process.stdin.resume()
