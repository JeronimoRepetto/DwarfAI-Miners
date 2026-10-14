#!/usr/bin/env node
// A stub "terminal session" and stub terminal tools for the observed-session keystroke relay's OS
// lane (17 §1.8: processes under test are stubs, never provider CLIs or real terminals). Started
// as `node console-keys.mjs <mode> ...` with no shell. The stub tools take their settings as
// arguments: the relay hands a tool only a named allowlist of its environment.
//
//   reader [maxMs]  Windows: reads its OWN console's input buffer (`CONIN$`, raw mode) — the hidden
//                   console a `windowsHide` child gets — and prints `ready` once it listens, then
//                   one `key <hex>` line per chunk it receives. Exits when its stdin ends or maxMs
//                   pass (default 30000), the cap keeping a forgotten stub from outliving its run.
//   ps <tty> ...    prints <tty>, as `ps -o tty= -p <pid>` prints a controlling terminal.
//   tmux <tty> <record> <args...>
//                   `list-panes ...` prints one pane on /dev/<tty> (`%7 /dev/<tty> 1`);
//                   `send-keys ...` appends its argv as one JSON line to the file <record>.
import { appendFileSync, openSync } from 'node:fs'
import { ReadStream } from 'node:tty'

const [mode, ...rest] = process.argv.slice(2)

if (mode === 'reader') {
  const maxMs = Number(rest[0] ?? 30_000)
  const cap = setTimeout(() => process.exit(0), Number.isFinite(maxMs) ? maxMs : 30_000)
  // `//./CONIN$`: Node resolves `CONIN$` alone as a relative file name.
  const input = new ReadStream(openSync('//./CONIN$', 'r+'))
  input.setRawMode(true)
  input.on('data', (chunk) => {
    process.stdout.write(`key ${Buffer.from(chunk).toString('hex')}\n`)
  })
  process.stdin.on('end', () => {
    clearTimeout(cap)
    process.exit(0)
  })
  process.stdin.resume()
  process.stdout.write('ready\n')
} else if (mode === 'ps') {
  process.stdout.write(`${rest[0] ?? '?'}\n`)
} else if (mode === 'tmux') {
  const [tty, record, ...args] = rest
  if (args[0] === 'list-panes') {
    process.stdout.write(`%7 /dev/${tty ?? 'none'} 1\n`)
  } else if (args[0] === 'send-keys' && record !== undefined) {
    appendFileSync(record, `${JSON.stringify(args)}\n`)
  } else {
    process.exit(1)
  }
} else {
  process.stderr.write(`console-keys: unknown mode ${JSON.stringify(mode)}\n`)
  process.exit(2)
}
