// layer: L2
// L2 flow (17 §1.2; UC-036; ADR-031 items 1–5; ADR-003 item 12): "Open console" and "Jump to
// terminal" resolved by the Host as host/main.ts composes them — conversation's `console` use case
// over `createHostConsoleResolver`, reading crew's real view of the dwarf — on the asking flow's
// Host (testing/askingHost.ts: the real boot step list over a temp world with the recorded observed
// Claude fixture session and its permission ask). The per-view token files go to the world's Host
// data dir (`run/viewers/`).
//
// Two facts are given here rather than produced, and why: observation records a Claude process
// identity only from the session registry's pid through the #45 guard, which the fixture world does
// not lay out, so the observed process is passed as observation would read it; and no launch
// reaches crew's session links in this build (main.ts `links.owned`, EPIC-10), so a launched dwarf
// is the same dwarf with the driver binding (INV-92 `usagePath: 'driver'`) its launch would give it.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type { DwarfId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { createHostConsoleResolver, type ConsoleTarget } from '../../modules/conversation'
import { askOf, cleanUp, evts, observedClaude, permissionRequest } from './testing/askingHost'

afterEach(cleanUp)

const PROCESS: ProcessIdentity = {
  pid: 4242,
  processStartTimeMs: 1_790_762_000_000,
  bootId: 'boot-1'
}
const UNKNOWN = '01920000-0000-7000-9000-0000000000ff' as DwarfId
const HEX_TOKEN = /[0-9a-f]{64}/

async function openConsoleHost(options: { launched?: boolean } = {}) {
  const fixture = await observedClaude({ scanner: new FsSourceWeightScanner() })
  const { h, w, dwarfId } = fixture
  const crew = h.crew?.crew.queries
  const conversation = h.conversation?.conversation
  if (crew === undefined || conversation === undefined) throw new Error('the Host was not wired')
  const consoles = createHostConsoleResolver({
    crew: {
      get: (id) => {
        const view = crew.get(id)
        if (view === null) return null
        return options.launched === true ? { ...view, usagePath: 'driver' } : view
      }
    },
    observed: { processIdentityOf: (id) => (id === dwarfId ? PROCESS : null) },
    clock: new FakeClock(1_790_762_400_000),
    ids: new SequenceIdGenerator(),
    hostDataDir: w.root,
    viewer: {
      program: join(w.root, 'app', 'dwarfai'),
      entry: join(w.root, 'app', 'out', 'host', 'dwarfai-viewer.js'),
      cwd: w.root
    }
  })
  const { resolveConsole } = conversation.console({ resolver: consoles.resolver })
  return { ...fixture, resolveConsole, consoles }
}

/** The token the target's credential file holds (its first line), as the viewer reads it. */
function tokenOf(target: ConsoleTarget): string {
  return readFileSync(target.credentialFile ?? '', 'utf8').split(/\n/)[0] ?? ''
}

describe('open console', () => {
  it('[US-MSG-007.AC06] a launched dwarf with no terminal of its own resolves to the read-only log view', async () => {
    const { resolveConsole, dwarfId, w } = await openConsoleHost({ launched: true })

    const target = await resolveConsole(dwarfId)

    expect(target.mode).toBe('log')
    expect(target.focus).toBeUndefined()
    expect(target.command?.args).toEqual([
      join(w.root, 'app', 'out', 'host', 'dwarfai-viewer.js'),
      target.credentialFile
    ])
    expect(target.credentialFile?.startsWith(join(w.root, 'run', 'viewers'))).toBe(true)
    expect(existsSync(target.credentialFile ?? '')).toBe(true)
  })

  it('[US-MSG-007.AC01, ADR-031] conversation.resolveConsole resolves every dwarf to a console target, observed ones to focus-terminal with log as fallback', async () => {
    const { resolveConsole, dwarfId } = await openConsoleHost()

    const observed = await resolveConsole(dwarfId)
    expect(observed).toMatchObject({
      mode: 'focus-terminal',
      focus: { pid: PROCESS.pid, startTime: PROCESS.processStartTimeMs }
    })
    expect(observed.command?.args.at(-1)).toBe(observed.credentialFile)
    // A dwarf the Host does not know still has a console: "no console" is never a state.
    expect((await resolveConsole(UNKNOWN)).mode).toBe('log')
  })

  it('[US-MSG-007.AC02, ADR-031] resolving the console of an asking dwarf leaves its ask open and unanswered', async () => {
    const { h, w, ui, notifier, token, dwarfId, resolveConsole } = await openConsoleHost()
    expect(await h.hook(token, permissionRequest(w))).toBe(204)
    await h.settle(ui, notifier)
    const asked = askOf(h, dwarfId)
    expect(asked?.state).toBe('open')

    // "Jump to terminal" on the card: the console resolves while the ask waits.
    await resolveConsole(dwarfId)
    await h.settle(ui, notifier)

    expect(askOf(h, dwarfId)).toEqual(asked)
    expect(h.crew?.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(evts(ui, 'ask.closed')).toEqual([])
  })

  it('[ADR-017] no target the ConsoleResolver returns ever carries a token or secret in args, only the token file path', async () => {
    const { resolveConsole, dwarfId } = await openConsoleHost()

    const targets = [await resolveConsole(dwarfId), await resolveConsole(UNKNOWN)]
    for (const target of targets) {
      const token = tokenOf(target)
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      const carried = [
        target.command?.program ?? '',
        target.command?.cwd ?? '',
        ...(target.command?.args ?? [])
      ]
      for (const value of carried) {
        expect(value.includes(token)).toBe(false)
        expect(value).not.toMatch(HEX_TOKEN)
      }
      expect(target.command?.args).toHaveLength(2)
      expect(target.command?.args[1]).toBe(target.credentialFile)
    }
  })
})
