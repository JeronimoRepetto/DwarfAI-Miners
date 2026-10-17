// L8 (17 §1.8): TerminalConsoleRaiser on this OS with real processes. The "terminal" is a stub, this
// Node binary running a script that records the argv, the environment variable and the folder it
// was started with, then exits: no window opens and no viewer runs (AGENTS §0.3: no desktop side
// effects in a test). The paths carry what a shell would read (`&`, `;`, `%PATH%`, `$(…)`, quotes,
// spaces), so arriving unchanged proves no shell parsed the argv (05 R17, 18 §4.2 T-11).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleTarget } from '@dwarfai/contracts'
import type { TerminalLaunch } from './consoleLaunch'
import { TerminalConsoleRaiser } from './TerminalConsoleRaiser'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const STUB_TERMINAL = `
const { writeFileSync } = require('node:fs')
const [, , out, ...argv] = process.argv
writeFileSync(out, JSON.stringify({ argv, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, cwd: process.cwd() }))
`

/** Waits until `path` holds JSON, polling every 25 ms, for at most 10 s. */
async function readWhenWritten(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      if (Date.now() > deadline) throw new Error('the stub terminal never ran')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-170-term-'))
  roots.push(root)
  const odd = join(root, `a b&c;d %PATH% $(x) 'q'`)
  mkdirSync(join(odd, 'run', 'viewers'), { recursive: true })
  const stub = join(root, 'stub-terminal.cjs')
  writeFileSync(stub, STUB_TERMINAL)
  const out = join(root, 'terminal-ran.json')
  const tokenFile = join(odd, 'run', 'viewers', '01920000-0000-7000-9000-00000000c0de.token')
  const target: ConsoleTarget = {
    mode: 'log',
    command: {
      program: join(odd, 'DwarfAI Miners'),
      args: [join(odd, 'dwarfai-viewer.js'), tokenFile],
      cwd: odd
    },
    credentialFile: tokenFile
  }
  /** The stub terminal in place of the OS terminal, handed the command's argv. */
  const chain = (options: {
    command: { program: string; args: readonly string[] }
  }): TerminalLaunch[] => [
    {
      command: process.execPath,
      args: [stub, out, options.command.program, ...options.command.args],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  ]
  return { root, odd, out, tokenFile, target, chain }
}

describe.runIf(['win32', 'darwin', 'linux'].includes(process.platform))(
  'TerminalConsoleRaiser on this OS',
  () => {
    it('[US-MSG-007.AC06] the OS terminal starts the viewer with the token file path as its only credential argument and no shell', async () => {
      const w = world()
      const raiser = new TerminalConsoleRaiser({ chain: w.chain })

      expect(await raiser.raise(w.target)).toBe('raised')
      const ran = await readWhenWritten(w.out)
      expect(ran).toEqual({
        argv: [join(w.odd, 'DwarfAI Miners'), join(w.odd, 'dwarfai-viewer.js'), w.tokenFile],
        runAsNode: '1',
        cwd: expect.stringContaining('a b&c;d') as unknown
      })
    })

    it('[FM-054] a terminal that cannot be launched reports failed and the log view stays available', async () => {
      const w = world()
      const missing: TerminalLaunch[] = [
        { command: join(w.root, 'no-such-terminal'), args: [] },
        { command: join(w.root, 'nor-this-one'), args: [] }
      ]
      const broken = new TerminalConsoleRaiser({ chain: () => missing })

      expect(await broken.raise(w.target)).toBe('failed')
      // The same target opens once a terminal is there: nothing was consumed by the failure.
      expect(await new TerminalConsoleRaiser({ chain: w.chain }).raise(w.target)).toBe('raised')
      expect((await readWhenWritten(w.out)).argv).toContain(w.tokenFile)
    })

    it('[NFR-PLAT-10] raiseConsole for a live identity focuses that terminal window and reports raised, with no toast', async () => {
      const w = world()
      const focused: number[] = []
      // The window raise itself is the OS's; here the live identity is this test process.
      const raiser = new TerminalConsoleRaiser({
        chain: w.chain,
        focus: (pid) => {
          focused.push(pid)
          return Promise.resolve(pid === process.pid)
        }
      })

      expect(
        await raiser.raise({
          ...w.target,
          mode: 'focus-terminal',
          focus: { pid: process.pid, startTime: 0 }
        })
      ).toBe('raised')
      expect(focused).toEqual([process.pid])
    })
  }
)
