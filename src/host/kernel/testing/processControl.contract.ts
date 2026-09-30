// The ProcessControl conformance suite (16 §3 row `ProcessControl`, 16 §2.8, 17 §1.3): run against
// FakeProcessControl and NodeProcessControl. It covers probe, sameProcess and spawn (ISSUE-018);
// killTree and currentBootIdentity join it with ISSUE-019.
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  matchesRecorded,
  type ProcessIdentity
} from '../domain/processIdentity'
import type { ProcessProbeAndSpawn, SpawnSpec, SpawnedProcess } from '../ports/processControl'

/** What a spawned echo target reports it received. */
export interface EchoedChild {
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

export interface ProcessControlSubject {
  control: ProcessProbeAndSpawn
  /** A pid that is alive but whose start time this subject cannot read. */
  unreadablePid: number
  /** A pid that no process has. */
  absentPid: number
  /** A spec that starts this subject's echo target with exactly `args` and `env`. */
  echoSpec(args: readonly string[], env: Readonly<Record<string, string>>): SpawnSpec
  /** The argv and environment the echo target received, once it has run. */
  received(child: SpawnedProcess): Promise<EchoedChild>
  /**
   * Variables the OS itself puts into every child environment whatever the spec says (on Windows,
   * libuv's required list); names only. Empty where the OS adds none.
   */
  osRequiredEnv: readonly string[]
  /** Puts `name=value` in the environment the subject's own process runs with; returns the undo. */
  setParentVariable(name: string, value: string): () => void
  /** Releases whatever the subject started. */
  dispose(): Promise<void>
}

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
      const { control, echoSpec, received, osRequiredEnv, setParentVariable } = setUp()
      const undo = setParentVariable('DWARFAI_CONTRACT_PARENT_ONLY', 'must-not-arrive')
      const env = { DWARFAI_SPEC_VAR: 'spec value; & | $(x)', SECOND_SPEC_VAR: '2' }
      try {
        const child = control.spawn(echoSpec([], env))
        const got = (await received(child)).env

        expect(got).toMatchObject(env)
        const allowed = new Set([...Object.keys(env), ...osRequiredEnv].map(upper))
        expect(Object.keys(got).filter((name) => !allowed.has(upper(name)))).toEqual([])
        expect(Object.keys(got).map(upper)).not.toContain('DWARFAI_CONTRACT_PARENT_ONLY')
      } finally {
        undo()
      }
    })
  })
}

// Windows environment names are case-insensitive; comparing upper-cased names is exact elsewhere
// because every name in this suite is upper case already.
const upper = (name: string): string => name.toUpperCase()
