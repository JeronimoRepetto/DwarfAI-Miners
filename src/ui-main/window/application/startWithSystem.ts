// "Start with the system" (07 machine 40; OQ-65; ADR-027 item 7; ADR-024 items 1, 2, 9; 13 FM-147): UI main owns the
// per-OS login entry and the UI preference `startWithSystem`, whose stored value is always the entry's verified state.
// Every apply writes (`AutostartPort.set`), then reads the entry back (`get()`) and stores what it read, so the toggle
// never shows something the OS refused; it runs at every start, before any window (S40.01, S40.02), and when the person
// changes the toggle (S40.03, S40.04). A refusal the person asked for is answered with the real state, which the window
// that asked shows with one message (S40.06); at a start it is only logged (S40.07). There is no automatic retry. The
// Host is never involved: turning it off never stops a running Host (OQ-65).
import type { LogRecord } from '@dwarfai/contracts'
import {
  nextStartWithSystem,
  type StartWithSystemEvent,
  type StartWithSystemNode,
  type StartWithSystemStep
} from '../domain/startWithSystemMachine'
import type { AutostartPort } from '../ports/autostartPort'
import type { UiPreferenceStore } from '../ports/uiPreferenceStore'

/** What `autostart.register` records (19 §9.6): the outcome, why it failed, and the trigger with the value applied. */
export type AutostartOutcome =
  'written' | 'unchanged' | 'repaired' | 'removed' | 'disabled-outside' | 'failed'

/**
 * The one record each apply writes (19 §9.6 `autostart.register`): `causeClass` is its outcome, `msg` the trigger
 * (`start` / `toggle`) and the value applied (`on` / `off`); `failed` is `warn`, the rest `info`.
 */
export type AutostartRegisterRecord = Required<
  Pick<LogRecord, 'level' | 'event' | 'subsystem' | 'outcome' | 'msg'>
> &
  Pick<LogRecord, 'errCode'> & {
    event: 'autostart.register'
    subsystem: 'window'
    causeClass: AutostartOutcome
  }

export interface StartWithSystemDeps {
  autostart: AutostartPort
  store: Pick<UiPreferenceStore, 'load' | 'save'>
  log: (record: AutostartRegisterRecord) => void
}

/** The answer to the person's toggle: the stored (verified) value, and whether the OS refused what was asked. */
export interface StartWithSystemAnswer {
  stored: boolean
  refused: boolean
}

export interface StartWithSystem {
  /** S40.01 / S40.02 at a start, normal or `--background`, before any window; answers the stored value. */
  applyAtStart(): boolean
  /** S40.03 / S40.04, the person's toggle (A-N21): the stored value, and whether the OS refused the request. */
  toggle(value: boolean): StartWithSystemAnswer
  /** The stored value (A-N20). */
  stored(): boolean
}

/** The `errCode` of a read-back that disagrees with a write that returned (FM-147). */
const READBACK_MISMATCH = 'readback-mismatch'
/** The `errCode` of a read-back that never returned: nothing is stored (S40.09). */
const READBACK_LOST = 'readback-lost'

/** An error's code (`EACCES`, …) or class name, never its message (ADR-026 item 4). */
function errCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code
  return error instanceof Error ? error.name : 'unknown'
}

function step(
  from: StartWithSystemNode | undefined,
  event: StartWithSystemEvent
): StartWithSystemStep {
  const next = nextStartWithSystem(from, event)
  // Every call below follows a transition 07 lists; any other is a defect, never a silent change.
  if (!next.ok)
    throw new Error(
      `start with the system: no transition from ${from?.state ?? '[*]'} on ${event.type}`
    )
  return next.value
}

export function createStartWithSystem(deps: StartWithSystemDeps): StartWithSystem {
  const { autostart, store, log } = deps
  const nodeOf = (value: boolean): StartWithSystemNode => ({ state: value ? 'on' : 'off' })
  /** The machine's node now: the stored value between applies (a fresh install loads ON, ADR-027 item 7). */
  let node: StartWithSystemNode = nodeOf(store.load('startWithSystem'))

  /** The entry as the OS reports it, or `undefined` when it cannot be read. */
  function read(): boolean | undefined {
    try {
      return autostart.get()
    } catch {
      return undefined
    }
  }

  function record(
    outcome: AutostartOutcome,
    trigger: 'start' | 'toggle',
    target: boolean,
    errCode?: string
  ): void {
    const failed = outcome === 'failed'
    log({
      level: failed ? 'warn' : 'info',
      event: 'autostart.register',
      subsystem: 'window',
      outcome: failed ? 'failed' : 'ok',
      causeClass: outcome,
      ...(errCode === undefined ? {} : { errCode }),
      msg: `${trigger} ${target ? 'on' : 'off'}`
    })
  }

  /** The verified value stored; when the store cannot write it, what is still stored (the store logged it). */
  function storeVerified(value: boolean): boolean {
    try {
      store.save('startWithSystem', value)
    } catch {
      // `uiprefs.write-failed` is the store's record.
    }
    return store.load('startWithSystem')
  }

  /** Writes `target`, reads the entry back and stores what it read (S40.05…S40.08); answers the stored value. */
  function apply(
    applying: StartWithSystemNode,
    trigger: 'start' | 'toggle'
  ): StartWithSystemAnswer {
    if (applying.state !== 'applying') throw new Error('start with the system: not applying')
    const { target } = applying
    const before = read()
    let errCode: string | undefined
    try {
      autostart.set(target)
    } catch (error) {
      errCode = errCodeOf(error)
    }
    const readBack = read()
    if (readBack === undefined) {
      // The real state is unknown: nothing is stored and the next start re-applies the stored value (S40.09).
      step(applying, { type: 'crashed' })
      record('failed', trigger, target, errCode ?? READBACK_LOST)
      const stored = store.load('startWithSystem')
      node = nodeOf(stored)
      return { stored, refused: true }
    }
    const next = step(applying, { type: 'applied', threw: errCode !== undefined, readBack })
    switch (next.id) {
      case 'S40.05':
        record(
          before === target
            ? 'unchanged'
            : !target
              ? 'removed'
              : trigger === 'start'
                ? 'repaired'
                : 'written',
          trigger,
          target
        )
        break
      case 'S40.08':
        record('disabled-outside', trigger, target)
        break
      default:
        record('failed', trigger, target, errCode ?? READBACK_MISMATCH)
    }
    const stored = storeVerified(readBack)
    node = nodeOf(stored)
    return { stored, refused: next.id !== 'S40.05' && next.id !== 'S40.08' }
  }

  return {
    applyAtStart: () => apply(step(node, { type: 'start' }).to ?? node, 'start').stored,
    toggle(value) {
      const asked = nextStartWithSystem(node, { type: 'toggled', value })
      // A toggle to the value already stored changes nothing (07 lists only ON → OFF and OFF → ON).
      if (!asked.ok || asked.value.to === null) {
        return { stored: store.load('startWithSystem'), refused: false }
      }
      return apply(asked.value.to, 'toggle')
    },
    stored: () => store.load('startWithSystem')
  }
}
