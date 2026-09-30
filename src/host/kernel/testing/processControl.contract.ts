// The ProcessControl conformance suite (16 §3 row `ProcessControl`, 16 §2.8, 17 §1.3): run against
// FakeProcessControl and NodeProcessControl. probe, sameProcess and spawn (ISSUE-018); killTree
// (ADR-014 items 2–4) and currentBootIdentity (AMENDMENT-3, ADR-015 item 4) (ISSUE-019).
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  matchesRecorded,
  sameBootField,
  type ProcessIdentity
} from '../domain/processIdentity'
import type { ProcessControl, SpawnSpec, SpawnedProcess } from '../ports/processControl'

/** What a spawned echo target reports it received. */
export interface EchoedChild {
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

/** One signal the subject saw sent: to one process, to a POSIX process group, or to a whole tree. */
export interface SentSignal {
  pid: number
  signal: 'term' | 'kill'
  scope: 'process' | 'group' | 'tree'
}

/** How a root set up for a kill case reacts to being signalled. */
export interface TreeBehaviour {
  /** The first signal that ends the root: a catchable one, only an uncatchable one, or none. */
  rootEndsOn: 'term' | 'kill' | 'never'
  /** `denied`: every signal to the root is refused as a missing permission (ADR-014 item 8). */
  access?: 'denied'
}

/** The subject's processes for the killTree cases: scripted for a fake, stubs for a real OS. */
export interface KillWorld {
  /** A live root with one child, both with the identity the subject reads for them. */
  liveTree(behaviour: TreeBehaviour): Promise<{ root: ProcessIdentity; child: ProcessIdentity }>
  /** Every signal sent so far, in order, whether or not it was allowed. */
  signals(): readonly SentSignal[]
  /** Whether `pid` still runs, as the subject's own processes know it. */
  isRunning(pid: number): Promise<boolean>
}

export interface ProcessControlSubject {
  control: ProcessControl
  /** The pid of the process the subject's control runs in; its identity is readable. */
  ownPid: number
  /** A pid that is alive but whose start time this subject cannot read. */
  unreadablePid: number
  /** A pid that no process has. */
  absentPid: number
  /** A spec that starts this subject's echo target with exactly `args` and `env`. */
  echoSpec(args: readonly string[], env: Readonly<Record<string, string>>): SpawnSpec
  /** The argv and environment the echo target received, once it has run. */
  received(child: SpawnedProcess): Promise<EchoedChild>
  /**
   * Names the OS or its runtime puts into a child's environment whatever the spec says, each with
   * a primary source in the adapter (Windows: libuv's required list; macOS: CoreFoundation's
   * `__CF_USER_TEXT_ENCODING`). Only these may appear beyond the spec; empty for the fake.
   */
  osAddedEnv: readonly string[]
  /** Puts `name=value` in the environment the subject's own process runs with; returns the undo. */
  setParentVariable(name: string, value: string): () => void
  /** Processes to end, and the signals the control sent them. */
  kill: KillWorld
  /** A control of the same kind whose every boot-identity source fails or times out. */
  failingBootIdentity(): ProcessControl
  /** Releases whatever the subject started. */
  dispose(): Promise<void>
}

const OWNED = { graceMs: 3_000, group: 'owned' } as const
const FOREIGN = { graceMs: 3_000, group: 'foreign' } as const
const BOOT_FIELDS = ['bootId', 'bootTimeMs', 'logonSessionId'] as const

/** Shell metacharacters that a shell would interpret and a shell-free spawn passes verbatim. */
export const SHELL_METACHARACTER_ARGS: readonly string[] = [
  'a & b',
  '|',
  ';',
  '$(whoami)',
  '`id`',
  '> out.txt',
  '< in.txt',
  '%PATH%',
  '*',
  '"double" \'single\''
]

export function runProcessControlContract(makeSubject: () => ProcessControlSubject): void {
  describe('ProcessControl contract', () => {
    let subject: ProcessControlSubject | null = null
    const setUp = (): ProcessControlSubject => {
      subject = makeSubject()
      return subject
    }
    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    it('[INV-51] an unreadable start time probes as unknown, and unknown never matches a recorded identity', async () => {
      const { control, unreadablePid } = setUp()

      const probed = await control.probe(unreadablePid)

      expect(probed).toBe('unknown')
      const recorded: ProcessIdentity = {
        pid: unreadablePid,
        processStartTimeMs: 1_790_000_000_000,
        bootId: 'recorded-boot'
      }
      expect(matchesRecorded(probed, recorded)).toBe(false)
      expect(matchesRecorded('absent', recorded)).toBe(false)
    })

    it('[INV-51] a pid that does not exist probes as absent', async () => {
      const { control, absentPid } = setUp()

      expect(await control.probe(absentPid)).toBe('absent')
    })

    it('[INV-51] sameProcess applies the one 2 000 ms tolerance at its boundary', () => {
      const { control } = setUp()
      const a: ProcessIdentity = { pid: 7, processStartTimeMs: 1_000_000, bootId: 'boot' }
      const at = (deltaMs: number): ProcessIdentity => ({
        ...a,
        processStartTimeMs: a.processStartTimeMs + deltaMs
      })

      expect(control.sameProcess(a, at(PROCESS_START_TOLERANCE_MS))).toBe(true)
      expect(control.sameProcess(a, at(-PROCESS_START_TOLERANCE_MS))).toBe(true)
      expect(control.sameProcess(a, at(PROCESS_START_TOLERANCE_MS + 1))).toBe(false)
      expect(control.sameProcess(a, at(-PROCESS_START_TOLERANCE_MS - 1))).toBe(false)
      expect(control.sameProcess(a, { ...a, bootId: 'other' })).toBe(false)
    })

    it('[INV-59] spawn never uses a shell: argv is passed as an array and shell metacharacters reach the child verbatim', async () => {
      const { control, echoSpec, received } = setUp()

      const child = control.spawn(echoSpec(SHELL_METACHARACTER_ARGS, { DWARFAI_SPEC_VAR: 'x' }))

      expect((await received(child)).args).toEqual(SHELL_METACHARACTER_ARGS)
    })

    it('[INV-59] spawn passes only the env given in the spec', async () => {
      const { control, echoSpec, received, osAddedEnv, setParentVariable } = setUp()
      const undo = setParentVariable('DWARFAI_CONTRACT_PARENT_ONLY', 'must-not-arrive')
      const env = { DWARFAI_SPEC_VAR: 'spec value; & | $(x)', SECOND_SPEC_VAR: '2' }
      try {
        const child = control.spawn(echoSpec([], env))
        const got = (await received(child)).env

        expect(got).toMatchObject(env)
        const allowed = new Set([...Object.keys(env), ...osAddedEnv].map(upper))
        expect(Object.keys(got).filter((name) => !allowed.has(upper(name)))).toEqual([])
        expect(Object.keys(got).map(upper)).not.toContain('DWARFAI_CONTRACT_PARENT_ONLY')
      } finally {
        undo()
      }
    })

    it('[ADR-014, INV-51, FM-066, CH-10] a target whose identity no longer matches is reported ended and nothing is signalled', async () => {
      const { control, kill } = setUp()
      const { root, child } = await kill.liveTree({ rootEndsOn: 'term' })
      const recycled: ProcessIdentity = {
        ...root,
        processStartTimeMs: root.processStartTimeMs - PROCESS_START_TOLERANCE_MS - 1
      }

      for (const opts of [OWNED, FOREIGN]) {
        expect(await control.killTree(recycled, opts)).toEqual({ kind: 'ended' })
      }
      expect(await control.killTree({ ...root, bootId: 'an-earlier-boot' }, OWNED)).toEqual({
        kind: 'ended'
      })

      expect(kill.signals()).toEqual([])
      expect(await kill.isRunning(root.pid)).toBe(true)
      expect(await kill.isRunning(child.pid)).toBe(true)
    })

    it("[ADR-014] killTree reports ended only after the root's exit is observed", async () => {
      const { control, kill } = setUp()
      const stubborn = await kill.liveTree({ rootEndsOn: 'never' })

      expect(await control.killTree(stubborn.root, OWNED)).toEqual({
        kind: 'failed',
        reason: 'still-alive'
      })
      expect(await kill.isRunning(stubborn.root.pid)).toBe(true)

      const yielding = await kill.liveTree({ rootEndsOn: 'kill' })
      expect(await control.killTree(yielding.root, OWNED)).toEqual({ kind: 'ended' })
      expect(await kill.isRunning(yielding.root.pid)).toBe(false)
      expect(await kill.isRunning(yielding.child.pid)).toBe(false)
      expect(
        kill.signals().some((sent) => sent.pid === yielding.root.pid && sent.signal === 'kill')
      ).toBe(true)
    })

    it('[ADR-014] an access-denied end is failed with reason access-denied, never ended', async () => {
      const { control, kill } = setUp()
      const { root } = await kill.liveTree({ rootEndsOn: 'term', access: 'denied' })

      for (const opts of [OWNED, FOREIGN]) {
        expect(await control.killTree(root, opts)).toEqual({
          kind: 'failed',
          reason: 'access-denied'
        })
      }
      expect(await kill.isRunning(root.pid)).toBe(true)
    })

    it('[ADR-014] group foreign never signals the process group', async () => {
      const { control, kill } = setUp()
      const { root, child } = await kill.liveTree({ rootEndsOn: 'term' })

      expect(await control.killTree(root, FOREIGN)).toEqual({ kind: 'ended' })

      expect(kill.signals().length).toBeGreaterThan(0)
      expect(kill.signals().filter((sent) => sent.scope === 'group')).toEqual([])
      expect(await kill.isRunning(root.pid)).toBe(false)
      expect(await kill.isRunning(child.pid)).toBe(false)
    })

    it('[ADR-014, INV-51] a root whose identity cannot be read now is failed no-identity and nothing is signalled', async () => {
      const { control, kill, unreadablePid } = setUp()
      const recorded: ProcessIdentity = {
        pid: unreadablePid,
        processStartTimeMs: 1_790_000_000_000,
        bootId: 'recorded-boot'
      }

      expect(await control.killTree(recorded, OWNED)).toEqual({
        kind: 'failed',
        reason: 'no-identity'
      })
      expect(kill.signals()).toEqual([])
    })

    it('[ADR-015] currentBootIdentity resolves with three fields and never rejects, even when every source fails', async () => {
      const { control, failingBootIdentity } = setUp()

      const working = await control.currentBootIdentity()
      expect(Object.keys(working).sort()).toEqual([...BOOT_FIELDS].sort())
      expect(typeof working.bootId).toBe('string')
      expect(working.bootTimeMs === 'unknown' || Number.isFinite(working.bootTimeMs)).toBe(true)
      expect(typeof working.logonSessionId).toBe('string')

      await expect(failingBootIdentity().currentBootIdentity()).resolves.toEqual({
        bootId: 'unknown',
        bootTimeMs: 'unknown',
        logonSessionId: 'unknown'
      })
    })

    it('[ADR-015] an unknown field never compares equal, not even to another unknown', async () => {
      const { control, failingBootIdentity } = setUp()
      const failing = failingBootIdentity()
      const first = await failing.currentBootIdentity()
      const second = await failing.currentBootIdentity()
      const known = await control.currentBootIdentity()

      for (const field of BOOT_FIELDS) {
        expect({ field, equal: sameBootField(first[field], second[field]) }).toEqual({
          field,
          equal: false
        })
        expect({ field, equal: sameBootField(known[field], first[field]) }).toEqual({
          field,
          equal: false
        })
      }
      expect(known.bootId).not.toBe('unknown')
      expect(sameBootField(known.bootId, known.bootId)).toBe(true)
    })

    it('[ADR-015] bootId agrees with probe(own pid).bootId when both are known, and two calls in one boot return equal known values', async () => {
      const { control, ownPid } = setUp()

      const probed = await control.probe(ownPid)
      const first = await control.currentBootIdentity()
      const second = await control.currentBootIdentity()

      expect(typeof probed).toBe('object')
      expect(first.bootId).toBe((probed as ProcessIdentity).bootId)
      for (const field of BOOT_FIELDS) {
        expect(first[field]).not.toBe('unknown')
        expect(sameBootField(first[field], second[field])).toBe(true)
      }
    })
  })
}

// Windows environment names are case-insensitive; comparing upper-cased names is exact elsewhere
// because every name in this suite is upper case already.
const upper = (name: string): string => name.toUpperCase()
