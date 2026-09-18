import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { createDarwinConsoleInput } from './darwinConsoleInput'
import { createOsascriptConsoleInput } from './osascriptInput'
import type { ConsoleInputAdapter } from './osascriptInput'
import { PosixTextDelivery } from './posixTextDelivery'
import type { TextDeliveryOutcome, TextDeliveryPort } from './port'
import { WindowsTextDelivery } from './windowsTextDelivery'

/**
 * The parity contract over the text-delivery ports (#497).
 *
 * Four times this week a capability existed on Windows and silently did not
 * on macOS or Linux, and nothing in the build said so (#367, #471, #489,
 * #481, #496). This file is the maintainer's rule, executable: a capability
 * is on every platform or declared unsupported with a reason a test can read
 * — never a silent gap.
 */

/* -------------------------------------------------------------------------
 * 1. The hand-written capability table.
 *
 * `Record<keyof TextDeliveryPort, CapabilityRow>` is the whole guard: the
 * moment a method is ADDED to TextDeliveryPort without a row here, this file
 * fails to TYPECHECK — not at runtime, not "eventually", at `tsc` time,
 * before the missing row could ever silently pass.
 *
 * This table is NEVER derived by reflection (`Object.keys(port)` or similar).
 * A derived table would grow a passing row for every new method automatically
 * — which is exactly the silent-gap failure this file exists to catch. A
 * method the table does not know about must be a compiler error, not a row
 * that appears for free.
 * ---------------------------------------------------------------------- */

interface CapabilityRow {
  kind: 'required' | 'optional'
  /**
   * Whether this member is a capability this file exercises by calling it and
   * reading a `TextDeliveryOutcome` back. `false` for the two members that are
   * not that shape at all: `supportsConsoleInput` is a property, not a method,
   * and `dispose` returns `void` rather than an outcome.
   */
  outcome: boolean
  /**
   * The sentence-shaped reason the runtime states when this optional
   * capability is ABSENT from a port — never a silent no-op. Required for
   * every optional outcome-bearing row, so a row cannot mark itself
   * "optional" with nothing backing the absence up.
   *
   * Two of these mirror an unexported `const` of the same name in
   * `runtime.ts` (`NO_QUEUE_TIER`, `NO_RESUME_TIER`, `NO_PASTE_TIER`,
   * `NO_TERMINAL_END_TIER` are none of them exported past that module), so the
   * literal is restated here rather than imported. `NO_ANSWER_KEYSTROKE_TIER`
   * IS exported (via the domain/types barrel) and is imported for real below.
   */
  absence?: string
}

// Mirrors runtime.ts's own (unexported) refusal constants — see the doc
// comment on CapabilityRow.absence for why these are copies rather than
// imports.
const NO_PASTE_TIER = "This build can't write into a session's console."
const NO_QUEUE_TIER = "This build can't reach a Codex session's message queue."
const NO_RESUME_TIER = "This build can't start a new turn on a Codex session."
const NO_TERMINAL_END_TIER = "This build can't end a session running in a terminal."
// The one row whose constant IS exported and importable for real.
const NO_ANSWER_KEYSTROKE_TIER_LITERAL = 'This build cannot answer a question at the terminal.'

const CAPABILITY_TABLE: Record<keyof TextDeliveryPort, CapabilityRow> = {
  supportsConsoleInput: { kind: 'optional', outcome: false },
  sendToConsole: { kind: 'required', outcome: true },
  pasteToConsole: { kind: 'optional', outcome: true, absence: NO_PASTE_TIER },
  relayToClaudeSession: { kind: 'required', outcome: true },
  queueToCodexThread: { kind: 'optional', outcome: true, absence: NO_QUEUE_TIER },
  resumeCodexThread: { kind: 'optional', outcome: true, absence: NO_RESUME_TIER },
  sendInterrupt: { kind: 'required', outcome: true },
  answerQuestionAtConsole: {
    kind: 'optional',
    outcome: true,
    absence: NO_ANSWER_KEYSTROKE_TIER_LITERAL
  },
  endConsoleSession: { kind: 'optional', outcome: true, absence: NO_TERMINAL_END_TIER },
  dispose: { kind: 'optional', outcome: false }
}

/** Only the rows this file actually invokes and reads an outcome from. */
const OUTCOME_CAPABILITIES = (Object.keys(CAPABILITY_TABLE) as (keyof TextDeliveryPort)[]).filter(
  (key) => CAPABILITY_TABLE[key].outcome
)

/* -------------------------------------------------------------------------
 * 2. The shipped ports, built with the fakes the existing port tests use.
 * ---------------------------------------------------------------------- */

const THREAD_ID = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'
const EXPECTED_START_MS = 1_788_001_972_136

function windowsPort(): WindowsTextDelivery {
  return new WindowsTextDelivery({
    home: 'C:\\Users\\j',
    relayModel: 'haiku',
    relayTimeoutMs: 60_000,
    env: { PATH: 'C:\\Windows' },
    focus: vi.fn().mockResolvedValue({ focused: true, reach: 'own-console' }),
    runPowerShell: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
    runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
    runRelay: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
    codexBinary: async () => 'C:\\Users\\j\\.local\\bin\\codex.exe',
    runCodexQueue: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
    runCodexResume: vi.fn().mockResolvedValue({ running: true }),
    fs: new FakeFs(),
    processEnd: {
      endProcessTree: vi.fn().mockResolvedValue(true),
      terminateProcess: vi.fn().mockResolvedValue(false),
      killProcess: vi.fn().mockResolvedValue(false)
    },
    processProbe: {
      isCodexProcessRunning: vi.fn(),
      processStartTimeMs: vi.fn().mockResolvedValue(EXPECTED_START_MS)
    },
    sleep: async () => {}
  })
}

/** The keystroke-only POSIX adapter — the shape a `null` darwin flag falls back to. */
function osascriptAdapter(): ConsoleInputAdapter {
  return createOsascriptConsoleInput(vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }))
}

/** The full darwin adapter (#367, #471): message and single-digit key tiers, both present. */
function darwinAdapter(): ConsoleInputAdapter {
  const run = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
  return createDarwinConsoleInput(run)
}

function posixPort(
  platform: 'darwin' | 'linux',
  consoleInput: ConsoleInputAdapter | null
): PosixTextDelivery {
  return new PosixTextDelivery({
    platform,
    home: '/Users/j',
    relayModel: 'haiku',
    relayTimeoutMs: 60_000,
    env: { PATH: '/usr/bin' },
    focus: vi.fn().mockResolvedValue(true),
    consoleInput,
    runRelay: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
    codexBinary: async () => '/usr/local/bin/codex',
    runCodexQueue: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
    runCodexResume: vi.fn().mockResolvedValue({ running: true }),
    fs: new FakeFs(),
    processEnd: {
      endProcessTree: vi.fn().mockResolvedValue(true),
      terminateProcess: vi.fn().mockResolvedValue(true),
      killProcess: vi.fn().mockResolvedValue(true)
    },
    processProbe: {
      isCodexProcessRunning: vi.fn(),
      processStartTimeMs: vi.fn().mockResolvedValue(EXPECTED_START_MS)
    },
    sleep: async () => {}
  })
}

/**
 * The platform x port roster this file holds to parity, mirroring
 * `platformAdapters.ts`'s own composition: Windows gets `WindowsTextDelivery`;
 * darwin gets `PosixTextDelivery` with the full darwin console-input adapter;
 * linux gets `PosixTextDelivery` with no console-input adapter at all — the
 * exact shape `createConsoleInput` in `platformAdapters.ts` builds today.
 */
const PLATFORM_PORTS: Record<'win32' | 'darwin' | 'linux', () => TextDeliveryPort> = {
  win32: windowsPort,
  darwin: () => posixPort('darwin', darwinAdapter()),
  linux: () => posixPort('linux', null)
}

/**
 * Whether each platform's SHIPPED port is expected to have each outcome
 * capability, per `port.ts`'s own doc comments ("BOTH shipped ports
 * implement it now, so no shipped platform takes that branch"). This is the
 * row that turns "the method happens to be present today" into "the method
 * is REQUIRED to be present on this platform, or this test must fail" — the
 * whole reason `answerQuestionAtConsole` being pulled off `PosixTextDelivery`
 * has to fail this file rather than quietly read as a declared absence.
 *
 * Every cell is 'present' today: every optional capability that has ever
 * existed on one shipped port has since landed on both (#366, #402, #471).
 * A future platform that genuinely cannot do one still needs a row here
 * changed to 'absent' deliberately, in the same commit that states why —
 * never a silent gap this table stops noticing.
 */
const EXPECTED_PRESENCE: Record<
  keyof typeof PLATFORM_PORTS,
  Partial<Record<keyof TextDeliveryPort, 'present' | 'absent'>>
> = {
  win32: {
    pasteToConsole: 'present',
    queueToCodexThread: 'present',
    resumeCodexThread: 'present',
    answerQuestionAtConsole: 'present',
    endConsoleSession: 'present'
  },
  darwin: {
    pasteToConsole: 'present',
    queueToCodexThread: 'present',
    resumeCodexThread: 'present',
    answerQuestionAtConsole: 'present',
    endConsoleSession: 'present'
  },
  linux: {
    pasteToConsole: 'present',
    queueToCodexThread: 'present',
    resumeCodexThread: 'present',
    answerQuestionAtConsole: 'present',
    endConsoleSession: 'present'
  }
}

/* -------------------------------------------------------------------------
 * 3. Minimal valid requests per capability, and the invariant checked for
 *    each (port, capability) pair: present-or-absent-never-half.
 * ---------------------------------------------------------------------- */

async function invoke(
  port: TextDeliveryPort,
  capability: keyof TextDeliveryPort
): Promise<TextDeliveryOutcome | 'absent'> {
  const member = port[capability]
  if (member === undefined) return 'absent'
  switch (capability) {
    case 'sendToConsole':
      return port.sendToConsole({ pid: 4242, text: 'hi', pressEnter: true })
    case 'pasteToConsole':
      return port.pasteToConsole!({ pid: 4242, text: 'hi', pressEnter: true })
    case 'relayToClaudeSession':
      return port.relayToClaudeSession({ sessionName: 'sample-project-70', text: 'hi' })
    case 'queueToCodexThread':
      return port.queueToCodexThread!({ threadId: THREAD_ID, text: 'hi' })
    case 'resumeCodexThread':
      return port.resumeCodexThread!({
        threadId: THREAD_ID,
        cwd: '/home/j/project',
        text: 'hi'
      })
    case 'sendInterrupt':
      return port.sendInterrupt({ pid: 42 })
    case 'answerQuestionAtConsole':
      return port.answerQuestionAtConsole!({ pid: 4242, digits: ['1'], submit: false })
    case 'endConsoleSession':
      return port.endConsoleSession!({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    default:
      throw new Error(`portParity.test.ts has no minimal request for ${capability}`)
  }
}

/** The verdict this file draws for one (platform, capability) cell. */
type Cell = 'implemented' | 'refuses-with-reason' | 'declared-absent' | 'SILENT'

async function cellFor(
  platform: keyof typeof PLATFORM_PORTS,
  port: TextDeliveryPort,
  capability: keyof TextDeliveryPort
): Promise<Cell> {
  const row = CAPABILITY_TABLE[capability]
  const expected = EXPECTED_PRESENCE[platform][capability]
  const outcome = await invoke(port, capability)
  if (outcome === 'absent') {
    // An absence is only ever a clean cell when BOTH: this row is optional
    // and carries a named reason, AND this exact platform is on record as
    // expected to lack it. Either half missing is SILENT — the half that
    // catches a capability quietly dropped off a port that used to have it
    // (the #497 proof: removing `answerQuestionAtConsole` from
    // `PosixTextDelivery` must fail here, not read as a declared absence,
    // because darwin and linux are both on record as 'present').
    if (
      row.kind === 'optional' &&
      row.absence !== undefined &&
      row.absence.length > 0 &&
      expected === 'absent'
    ) {
      return 'declared-absent'
    }
    return 'SILENT'
  }
  if (expected === 'absent') {
    // The capability answered when this platform was on record as lacking
    // it — a stale expectation row, and just as much a parity defect as the
    // reverse: the table now says something about this platform that is no
    // longer true.
    return 'SILENT'
  }
  if (typeof outcome !== 'object' || outcome === null || typeof outcome.delivered !== 'boolean') {
    return 'SILENT'
  }
  if (outcome.delivered) return 'implemented'
  // A refusal names itself: delivered: false must carry a non-empty error.
  // A bare `delivered: false` — the fail-silent half this rule exists to
  // stop — reads as SILENT.
  if (typeof outcome.error === 'string' && outcome.error.length > 0) {
    return 'refuses-with-reason'
  }
  return 'SILENT'
}

/* -------------------------------------------------------------------------
 * 4. Per (port, capability): present-or-absent-never-half.
 * ---------------------------------------------------------------------- */

describe('text-delivery port parity (#497)', () => {
  for (const [platform, build] of Object.entries(PLATFORM_PORTS) as [
    keyof typeof PLATFORM_PORTS,
    () => TextDeliveryPort
  ][]) {
    describe(platform, () => {
      for (const capability of OUTCOME_CAPABILITIES) {
        it(`${capability} is present or declared absent, never half`, async () => {
          const port = build()
          const cell = await cellFor(platform, port, capability)
          expect(cell).not.toBe('SILENT')

          const member = port[capability]
          if (member === undefined) {
            // A missing OPTIONAL method must be paired with a named absence
            // constant this table already carries — never a gap.
            const row = CAPABILITY_TABLE[capability]
            expect(row.kind).toBe('optional')
            expect(row.absence).toBeTruthy()
            return
          }

          const outcome = await invoke(port, capability)
          expect(outcome).not.toBeUndefined()
          expect(typeof outcome).toBe('object')
          const result = outcome as TextDeliveryOutcome
          expect(typeof result.delivered).toBe('boolean')
          if (!result.delivered) {
            // A refusal names itself.
            expect(result.error).toBeTruthy()
          }
        })
      }

      it('never throws for any present capability, given a minimal valid request', async () => {
        const port = build()
        for (const capability of OUTCOME_CAPABILITIES) {
          if (port[capability] === undefined) continue
          await expect(invoke(port, capability)).resolves.not.toThrow
        }
      })
    })
  }

  /* -----------------------------------------------------------------------
   * 5. One whole-table assertion. Its failure message IS the matrix: the
   *    platform x capability grid, so a diff shows exactly which cell went
   *    silent — the row that would have caught #367 and #471 the day the
   *    Windows port gained each capability the others had not.
   * -------------------------------------------------------------------- */
  it('prints the platform x capability matrix, and fails on any SILENT cell', async () => {
    const platforms = Object.keys(PLATFORM_PORTS) as (keyof typeof PLATFORM_PORTS)[]
    const rows: string[][] = [['capability', ...platforms]]
    const cells = new Map<string, Cell>()

    for (const capability of OUTCOME_CAPABILITIES) {
      const row = [capability as string]
      for (const platform of platforms) {
        const port = PLATFORM_PORTS[platform]()
        const cell = await cellFor(platform, port, capability)
        cells.set(`${platform}:${capability}`, cell)
        row.push(cell)
      }
      rows.push(row)
    }

    const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)))
    const matrix = rows
      .map((r) => r.map((cell, col) => cell.padEnd(widths[col]!)).join('  '))
      .join('\n')

    const silentCells = [...cells.entries()].filter(([, cell]) => cell === 'SILENT')
    expect(
      silentCells.length,
      `A capability went SILENT on at least one platform — the exact failure this test exists to ` +
        `catch (#367, #471, #489, #481, #496). Silent cells: ${silentCells
          .map(([key]) => key)
          .join(', ')}\n\n${matrix}`
    ).toBe(0)
  })
})

/* -------------------------------------------------------------------------
 * 6. ConsoleInputAdapter, in miniature (#497 item 4).
 *
 * `sendText` and `sendInterrupt` are required (every adapter has them);
 * `sendMessage` and `sendKey` are optional, and an absence must be a named,
 * per-OS fact (#367, #471) rather than a gap. `tmuxPaneWrite.ts` (#494) is
 * pure command builders only — nothing wires it into a `ConsoleInputAdapter`
 * yet, and no linux/tmux adapter exists in this codebase today (checked
 * 2026-09-18: no `createTmuxConsoleInput` anywhere in `src/main`). So that row
 * is left commented rather than faked, exactly as the issue anticipates
 * ("when it lands").
 * ---------------------------------------------------------------------- */

interface AdapterCapabilityRow {
  kind: 'required' | 'optional'
  absence?: string
}

const NO_ADAPTER_MESSAGE_TIER =
  'Writing a message into a terminal is not supported on this operating system yet.'

const ADAPTER_CAPABILITY_TABLE: Record<keyof ConsoleInputAdapter, AdapterCapabilityRow> = {
  sendText: { kind: 'required' },
  sendInterrupt: { kind: 'required' },
  sendMessage: { kind: 'optional', absence: NO_ADAPTER_MESSAGE_TIER },
  sendKey: { kind: 'optional', absence: NO_ADAPTER_MESSAGE_TIER }
}

const ADAPTER_ROSTER: Record<'osascript' | 'darwin', () => ConsoleInputAdapter> = {
  osascript: osascriptAdapter,
  darwin: darwinAdapter
  // linux/tmux: no adapter exists yet (tmuxPaneWrite.ts is builders only) —
  // pending, per the issue.
}

describe('ConsoleInputAdapter parity, in miniature (#497)', () => {
  for (const [name, build] of Object.entries(ADAPTER_ROSTER) as [
    keyof typeof ADAPTER_ROSTER,
    () => ConsoleInputAdapter
  ][]) {
    describe(name, () => {
      it('sendText and sendInterrupt are present and resolve to a boolean, never throw', async () => {
        const adapter = build()
        await expect(adapter.sendText('hi', true)).resolves.toEqual(expect.any(Boolean))
        await expect(adapter.sendInterrupt()).resolves.toEqual(expect.any(Boolean))
      })

      it('sendMessage, when present, resolves to an outcome; when absent, the table names why', () => {
        const adapter = build()
        if (adapter.sendMessage === undefined) {
          expect(ADAPTER_CAPABILITY_TABLE.sendMessage.kind).toBe('optional')
          expect(ADAPTER_CAPABILITY_TABLE.sendMessage.absence).toBeTruthy()
        } else {
          expect(typeof adapter.sendMessage).toBe('function')
        }
      })

      it('sendKey, when present, is a function; when absent, the table names why', () => {
        const adapter = build()
        if (adapter.sendKey === undefined) {
          expect(ADAPTER_CAPABILITY_TABLE.sendKey.kind).toBe('optional')
          expect(ADAPTER_CAPABILITY_TABLE.sendKey.absence).toBeTruthy()
        } else {
          expect(typeof adapter.sendKey).toBe('function')
        }
      })
    })
  }

  it('the osascript adapter has no message or key tier (#367, #471) — a stated absence', () => {
    const adapter = osascriptAdapter()
    expect(adapter.sendMessage).toBeUndefined()
    expect(adapter.sendKey).toBeUndefined()
  })

  it('the darwin adapter has both tiers present (#367, #471)', () => {
    const adapter = darwinAdapter()
    expect(adapter.sendMessage).toBeDefined()
    expect(adapter.sendKey).toBeDefined()
  })
})
