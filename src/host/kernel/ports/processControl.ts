// Kernel driven port (05 §3, 16 §3 row `ProcessControl`; frozen): the Host's only way to read,
// start and end OS processes. `probe` answers `'unknown'` when the start time cannot be read, and
// `'unknown'` is a mismatch for re-adoption and kill (#231 polarity, 06 INV-51); `sameProcess`
// uses the ONE tolerance constant of ProcessIdentity's module (ADR-015 item 1); `spawn` never uses
// a shell (R17, ADR-029).
import type { Readable, Writable } from 'node:stream'
import type { EndOutcome, ProcessIdentity } from '../domain/processIdentity'

export type { EndOutcome, ProcessIdentity } from '../domain/processIdentity'

export interface ProcessControl {
  probe(pid: number): Promise<ProcessIdentity | 'absent' | 'unknown'>
  // Amended: 16 §3 ProcessControl.isRunning (owner amendment H, 2026-10-07). Whether any process
  // has `pid`, by existence only (signal 0 / ESRCH): it never spawns and never reads a start time,
  // so it is never evidence of identity (06 INV-51); only `absent` is evidence, of no process.
  isRunning(pid: number): 'running' | 'absent' | 'unknown'
  sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean
  spawn(spec: SpawnSpec): SpawnedProcess
  killTree(
    target: ProcessIdentity,
    opts: { graceMs: number; group: 'owned' | 'foreign' }
  ): Promise<EndOutcome>
  currentBootIdentity(): Promise<{
    bootId: string | 'unknown'
    bootTimeMs: number | 'unknown'
    logonSessionId: string | 'unknown'
  }>
}

/** AMENDMENT-10 (OQ-78): `shell: false` and `windowsHide: true` are fixed in the adapter, never here. */
export interface SpawnSpec {
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  processGroup: 'own' | 'inherit'
  stdio: 'pipe' | 'ignore'
}

/** AMENDMENT-10 (OQ-78): `identity` resolves once the root's identity is read, `exited` when it exits. */
export interface SpawnedProcess {
  identity: Promise<ProcessIdentity>
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  exited: Promise<{ code: number | null; signal: string | null }>
}
