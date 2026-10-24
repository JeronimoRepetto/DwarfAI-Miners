// L8 OS lane (17 §1.8): the observed-subagent route's console reading and navigation keys
// (AMENDMENT-29) over the real kernel `NodeProcessControl` and a real `powershell.exe`, against a stub
// lead terminal the test starts itself (fixtures/claude/console/stub/lead-console.mjs), never a real
// Claude Code and never a visible terminal. Windows only: elsewhere the route offers nothing.
//
// The stub draws a Claude Code 2.1.310 screen of fixtures/claude/console/2.1.310 into the hidden
// console every `windowsHide` child gets, and reports every key its console input receives. Proves:
// what the route reads back through `CONOUT$` is the screen drawn, glyphs intact, and reads as the
// same screen; ↓, ↑ and Enter arrive as the keys a terminal sends. Every process is the test's own and
// is ended by closing its stdin, then awaited.
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { SpawnedProcess } from '../../../../kernel/ports/processControl'
import { NodeScheduler } from '../../../../platform/clock/NodeScheduler'
import { NodeProcessControl } from '../../../../platform/process/NodeProcessControl'
import { readAgentConsole } from './claudeAgentConsole'
import { agentConsoleScreen, AGENT_CONSOLE_SCREENS } from './testing/agentConsoleScreens'
import { WindowsConsoleScreen } from './WindowsConsoleScreen'

const STUB = fileURLToPath(
  new URL('../../../../../../fixtures/claude/console/stub/lead-console.mjs', import.meta.url)
)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The environment a stub process gets: only what node needs to start. */
function stubEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

describe.runIf(process.platform === 'win32')(
  'WindowsConsoleScreen on Windows: a stub lead terminal (AMENDMENT-29)',
  () => {
    const control = new NodeProcessControl()
    const children: SpawnedProcess[] = []
    const taskErrors: unknown[] = []

    afterEach(async () => {
      for (const child of children) child.stdin?.end()
      await Promise.all(
        children.splice(0).map((child) => Promise.race([child.exited, sleep(10_000)]))
      )
      expect(taskErrors.splice(0)).toEqual([])
    })

    /** Starts the stub on `screen`, resolves once it drew and listens, with what it printed. */
    async function stub(screen: string): Promise<{ identity: ProcessIdentity; out: () => string }> {
      const child = control.spawn({
        executable: process.execPath,
        args: [STUB, join(AGENT_CONSOLE_SCREENS, `${screen}.txt`)],
        env: stubEnv(),
        cwd: dirname(STUB),
        processGroup: 'inherit',
        stdio: 'pipe'
      })
      children.push(child)
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
      for (let waited = 0; !out.includes('ready\n') && waited < 15_000; waited += 50) {
        await sleep(50)
      }
      expect(out).toContain('ready\n')
      return { identity: await child.identity, out: () => out }
    }

    function screen(): WindowsConsoleScreen {
      return new WindowsConsoleScreen({
        processes: control,
        platform: 'win32',
        env: process.env,
        cwd: tmpdir(),
        scheduler: new NodeScheduler({ onTaskError: (error) => taskErrors.push(error) })
      })
    }

    it('[ADR-012, ADR-014] reads back the screen the lead terminal shows, glyphs intact, as the same screen', async () => {
      const { identity } = await stub('view-echo-list')
      const read = await screen().read(identity)
      expect(read.kind).toBe('screen')
      const lines = read.kind === 'screen' ? read.lines : []
      const drawn = agentConsoleScreen('view-echo-list')
      expect(lines.slice(0, drawn.length)).toEqual(drawn)
      expect(readAgentConsole(lines)).toEqual(readAgentConsole(drawn))
    }, 60_000)

    it('[ADR-012, ADR-014] ↓, ↑ and Enter reach that console as the keys a terminal sends', async () => {
      const { identity, out } = await stub('lead-input-empty')
      const keys = screen()
      for (const key of ['down', 'up', 'enter'] as const) {
        expect(await keys.press(identity, key)).toBe('pressed')
      }
      for (let waited = 0; out().split('key ').length < 4 && waited < 10_000; waited += 50) {
        await sleep(50)
      }
      expect(
        out()
          .split('\n')
          .filter((line) => line.startsWith('key '))
      ).toEqual(['key 1b5b42', 'key 1b5b41', 'key 0d'])
    }, 60_000)

    it('[ADR-014] a process that is gone is never attached to', async () => {
      const { identity } = await stub('lead-input-empty')
      const recycled = { ...identity, processStartTimeMs: identity.processStartTimeMs + 60_000 }
      expect(await screen().read(recycled)).toEqual({ kind: 'gone' })
      expect(await screen().press(recycled, 'down')).toBe('gone')
    }, 60_000)
  }
)
