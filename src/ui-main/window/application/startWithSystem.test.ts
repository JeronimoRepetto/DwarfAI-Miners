// layer: L2
import { describe, expect, it } from 'vitest'
import {
  nextStartWithSystem,
  type StartWithSystemEvent,
  type StartWithSystemNode
} from '../domain/startWithSystemMachine'
import { LOGIN_ENTRY_ARGS, uiStartPlanOf } from '../domain/uiStart'
import { FakeAutostartPort } from '../ports/fakes/FakeAutostartPort'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore
} from '../ports/fakes/InMemoryUiPreferenceStore'
import { RecordingHostClient } from '../ports/fakes/RecordingHostClient'
import { createStartWithSystem, type AutostartRegisterRecord } from './startWithSystem'

/**
 * "Start with the system" (07 machine 40; OQ-65; ADR-027 item 7; ADR-024 items 1, 2, 9; 13 FM-147): UI main stores the
 * verified state of the per-OS login entry, read back after every write, so the toggle never shows something the OS
 * refused; it re-applies the stored value at every start, before any window. The app's launch path in the login entry
 * is the OS's executable plus `LOGIN_ENTRY_ARGS`.
 */
const APP = 'C:/Program Files/DwarfAI-Miners/DwarfAI-Miners.exe'

/** UI main as it starts, over one preference folder and the OS's one login entry, each kept across starts. */
function machine(storage = createInMemoryUiPreferenceStorage(), entry = new FakeAutostartPort()) {
  const logged: AutostartRegisterRecord[] = []
  const store = new InMemoryUiPreferenceStore(storage)
  const startWithSystem = createStartWithSystem({
    autostart: entry,
    store,
    log: (record) => logged.push(record)
  })
  return { storage, entry, logged, startWithSystem }
}

describe('Start with the system (07 machine 40)', () => {
  it('[US-SET-002.AC10, S40.01] on a new install the start writes the entry and stores ON', () => {
    const { entry, storage, logged, startWithSystem } = machine()

    expect(startWithSystem.applyAtStart()).toBe(true)

    expect(entry.calls).toEqual(['get', 'set true', 'get'])
    expect(entry.entry).toBe('enabled')
    expect(storage.stored.startWithSystem).toBe(true)
    expect(startWithSystem.stored()).toBe(true)
    expect(logged).toEqual([
      {
        level: 'info',
        event: 'autostart.register',
        subsystem: 'window',
        outcome: 'ok',
        causeClass: 'repaired',
        msg: 'start on'
      }
    ])
  })

  it('[US-RES-002.AC11, S40.11] with ON an OS-login start is a background start that opens the tray and no window', () => {
    const { entry, startWithSystem } = machine()
    startWithSystem.applyAtStart()
    expect(entry.entry).toBe('enabled')

    // S40.11: the entry the OS runs at login starts the app's launch path with its arguments; that start is tray-only.
    expect(nextStartWithSystem({ state: 'on' }, { type: 'os-login' })).toEqual({
      ok: true,
      value: { id: 'S40.11', to: { state: 'on' } }
    })
    expect(uiStartPlanOf([APP, ...LOGIN_ENTRY_ARGS])).toEqual({
      kind: 'background',
      tray: true,
      window: false
    })
  })

  it('[US-RES-002.AC13, S10.03] a background start opens no window until the person opens the app', () => {
    // The background start builds no window; the person opening the app is a normal launch, which does (S10.13).
    expect(uiStartPlanOf([APP, '--background'])).toEqual({
      kind: 'background',
      tray: true,
      window: false
    })
    expect(uiStartPlanOf([APP])).toEqual({ kind: 'normal', tray: true, window: true })
    // Only the exact flag makes a start a background one.
    expect(uiStartPlanOf([APP, '--background=no']).kind).toBe('normal')
    expect(uiStartPlanOf([APP, 'C:/work/--background']).kind).toBe('normal')
  })

  it('[US-SET-002.AC11, S40.03] turning it off removes the entry, stores OFF and leaves a running Host untouched', () => {
    const host = new RecordingHostClient()
    const { entry, storage, logged, startWithSystem } = machine()
    startWithSystem.applyAtStart()
    logged.length = 0
    entry.calls.length = 0

    expect(startWithSystem.toggle(false)).toEqual({ stored: false, refused: false })

    expect(entry.calls).toEqual(['get', 'set false', 'get'])
    expect(entry.entry).toBe('absent')
    expect(storage.stored.startWithSystem).toBe(false)
    expect(logged).toEqual([
      {
        level: 'info',
        event: 'autostart.register',
        subsystem: 'window',
        outcome: 'ok',
        causeClass: 'removed',
        msg: 'toggle off'
      }
    ])
    // OQ-65: the toggle only affects the next login; nothing reaches the Host, which keeps running.
    expect(host.calls).toEqual([])
  })

  it('[US-SET-002.AC12, S40.04] turning it back on writes the entry again and stores ON', () => {
    const { entry, storage, logged, startWithSystem } = machine()
    startWithSystem.applyAtStart()
    startWithSystem.toggle(false)
    logged.length = 0

    expect(startWithSystem.toggle(true)).toEqual({ stored: true, refused: false })

    expect(entry.entry).toBe('enabled')
    expect(entry.writes).toBe(2)
    expect(storage.stored.startWithSystem).toBe(true)
    expect(logged.map((r) => [r.causeClass, r.msg])).toEqual([['written', 'toggle on']])
    // The next start finds the entry and leaves it as it is.
    const next = machine(storage, entry)
    expect(next.startWithSystem.applyAtStart()).toBe(true)
    expect(next.logged.map((r) => [r.causeClass, r.msg])).toEqual([['unchanged', 'start on']])
  })

  it('[S40.06, FM-147] a refused write the person asked for stores the real state and shows one message', () => {
    // The removal is refused: the entry stays, so ON is stored and answered; the window that asked shows one message.
    const { entry, storage, logged, startWithSystem } = machine()
    startWithSystem.applyAtStart()
    logged.length = 0
    entry.refuse = 'next'

    expect(startWithSystem.toggle(false)).toEqual({ stored: true, refused: true })
    expect(storage.stored.startWithSystem).toBe(true)
    expect(entry.entry).toBe('enabled')
    expect(logged).toEqual([
      {
        level: 'warn',
        event: 'autostart.register',
        subsystem: 'window',
        outcome: 'failed',
        causeClass: 'failed',
        errCode: 'EACCES',
        msg: 'toggle off'
      }
    ])

    // A read-back that disagrees with a write that returned: the real state is stored, never the requested one.
    expect(startWithSystem.toggle(false)).toEqual({ stored: false, refused: false })
    logged.length = 0
    entry.calls.length = 0
    entry.disagreeOnReadBack = true
    expect(startWithSystem.toggle(true)).toEqual({ stored: false, refused: true })
    expect(storage.stored.startWithSystem).toBe(false)
    // No automatic retry: one write for the one request.
    expect(entry.calls.filter((call) => call.startsWith('set'))).toEqual(['set true'])
    expect(logged.map((r) => [r.outcome, r.errCode, r.msg])).toEqual([
      ['failed', 'readback-mismatch', 'toggle on']
    ])
  })

  it('[S40.07] a refused repair at a start is only logged', () => {
    // Stored ON, the entry missing, and the OS refuses to write it at a start nobody asked for.
    const storage = createInMemoryUiPreferenceStorage()
    storage.stored.startWithSystem = true
    const entry = new FakeAutostartPort()
    entry.refuse = 'next'
    const { logged, startWithSystem } = machine(storage, entry)

    expect(startWithSystem.applyAtStart()).toBe(false)
    expect(storage.stored.startWithSystem).toBe(false)
    expect(logged).toEqual([
      {
        level: 'warn',
        event: 'autostart.register',
        subsystem: 'window',
        outcome: 'failed',
        causeClass: 'failed',
        errCode: 'EACCES',
        msg: 'start on'
      }
    ])
  })

  it('[S40.08] an entry disabled in the OS startup list stores OFF and writes nothing', () => {
    const storage = createInMemoryUiPreferenceStorage()
    const entry = new FakeAutostartPort()
    machine(storage, entry).startWithSystem.applyAtStart()
    const writes = entry.writes
    // The person disables DwarfAI in the OS's own startup list.
    entry.disableInOs()

    const next = machine(storage, entry)
    expect(next.startWithSystem.applyAtStart()).toBe(false)

    expect(storage.stored.startWithSystem).toBe(false)
    expect(entry.writes).toBe(writes)
    expect(entry.entry).toBe('disabled-in-os')
    // Recorded, no message: the person's OS choice is respected as OFF.
    expect(next.logged).toEqual([
      {
        level: 'info',
        event: 'autostart.register',
        subsystem: 'window',
        outcome: 'ok',
        causeClass: 'disabled-outside',
        msg: 'start on'
      }
    ])
  })

  it('[S40.02, S40.05, S40.09, S40.12, S40.13] every machine 40 transition reaches its target: the stored value re-applied at each start, the verified value stored, a crash while applying stores nothing, an OS login with OFF starts nothing, and an uninstall removes the entry but keeps the value; a transition 07 does not list is rejected', () => {
    const on: StartWithSystemNode = { state: 'on' }
    const off: StartWithSystemNode = { state: 'off' }
    const applying = (target: boolean, asked: boolean): StartWithSystemNode => ({
      state: 'applying',
      target,
      asked
    })
    const start: StartWithSystemEvent = { type: 'start' }
    const applied = (threw: boolean, readBack: boolean): StartWithSystemEvent => ({
      type: 'applied',
      threw,
      readBack
    })

    const listed: Array<
      [string, StartWithSystemNode | undefined, StartWithSystemEvent, StartWithSystemNode | null]
    > = [
      ['S40.01', undefined, start, applying(true, false)],
      ['S40.02', on, start, applying(true, false)],
      ['S40.02', off, start, applying(false, false)],
      ['S40.03', on, { type: 'toggled', value: false }, applying(false, true)],
      ['S40.04', off, { type: 'toggled', value: true }, applying(true, true)],
      ['S40.05', applying(true, false), applied(false, true), on],
      ['S40.05', applying(false, true), applied(false, false), off],
      ['S40.06', applying(false, true), applied(true, true), on],
      ['S40.06', applying(true, true), applied(false, false), off],
      ['S40.06', applying(true, true), applied(true, false), off],
      ['S40.07', applying(false, false), applied(true, true), on],
      ['S40.07', applying(true, false), applied(true, false), off],
      ['S40.08', applying(true, false), applied(false, false), off],
      ['S40.09', applying(true, true), { type: 'crashed' }, null],
      ['S40.10', on, { type: 'reset', asked: true }, applying(true, true)],
      ['S40.10', off, { type: 'reset', asked: false }, applying(true, false)],
      ['S40.10', applying(false, true), { type: 'reset', asked: true }, applying(true, true)],
      ['S40.11', on, { type: 'os-login' }, on],
      ['S40.12', off, { type: 'os-login' }, off],
      ['S40.13', on, { type: 'uninstalled' }, on],
      ['S40.13', off, { type: 'uninstalled' }, off]
    ]
    for (const [id, from, event, to] of listed) {
      expect(
        nextStartWithSystem(from, event),
        `${id} from ${from?.state ?? '[*]'} on ${event.type}`
      ).toEqual({
        ok: true,
        value: { id, to }
      })
    }
    const ids = new Set(listed.map(([id]) => id))
    expect(ids.size).toBe(13)

    const unlisted: Array<[StartWithSystemNode | undefined, StartWithSystemEvent]> = [
      [undefined, { type: 'toggled', value: true }],
      [undefined, applied(false, true)],
      [undefined, { type: 'os-login' }],
      [on, { type: 'toggled', value: true }],
      [off, { type: 'toggled', value: false }],
      [on, applied(false, true)],
      [off, { type: 'crashed' }],
      [applying(true, true), start],
      [applying(true, true), { type: 'toggled', value: false }],
      [applying(true, false), { type: 'os-login' }],
      [applying(true, false), { type: 'uninstalled' }]
    ]
    for (const [from, event] of unlisted) {
      expect(nextStartWithSystem(from, event), `${from?.state ?? '[*]'} on ${event.type}`).toEqual({
        ok: false,
        error: 'not-listed'
      })
    }

    // The application walks the same table: a stored OFF is re-applied (removed) at each start (S40.02 → S40.05), and a
    // crash while applying stores nothing, so the next start re-applies the stored value (S40.09 → S40.02).
    const storage = createInMemoryUiPreferenceStorage()
    storage.stored.startWithSystem = false
    const entry = new FakeAutostartPort()
    entry.entry = 'enabled'
    const first = machine(storage, entry)
    expect(first.startWithSystem.applyAtStart()).toBe(false)
    expect(entry.entry).toBe('absent')
    expect(first.logged.map((r) => [r.causeClass, r.msg])).toEqual([['removed', 'start off']])

    // The read-back never returns (the process is ending): the toggle stores nothing and answers the stored OFF.
    const crashing = new FakeAutostartPort()
    const lost = machine(storage, crashing)
    lost.startWithSystem.applyAtStart()
    crashing.get = () => {
      throw new Error('the UI process ended while reading the entry back')
    }
    expect(lost.startWithSystem.toggle(true)).toEqual({ stored: false, refused: true })
    expect(storage.stored.startWithSystem).toBe(false)
  })
})
