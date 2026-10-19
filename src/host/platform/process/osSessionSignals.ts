// How the Host learns that the OS session is ending (ADR-002 D7 (c); 07 S12.10). R18: the OS
// branching lives here; transport/lifecycle/osSessionEnd.ts maps the report to a clean exit with
// the marker reason `os-session-end`.
//
// The package names no detection mechanism; the Host has no window (ADR-002 D1, no Electron), so
// it can only take process signals as Node delivers them:
//
// - linux, darwin: SIGTERM — what a session manager or init sends the processes of a session that
//   ends — and SIGHUP — the hangup of the session the process belongs to.
// - win32: SIGHUP — what Node raises on CTRL_CLOSE_EVENT. A detached Host with no console may get
//   no notice at all at logoff or shutdown.
//
// None of them has been observed at a real logout or shutdown on any OS yet, so each is UNVERIFIED
// and logged as such when it fires (`host.os-session-end`, warn, degraded; a source verified later
// fires without that record). Where no notice
// arrives the Host ends without a marker, and the next boot still tells a reboot or logout from a
// crash by the boot identity it recorded (ADR-015 item 4), independently of any marker (ADR-002
// D7).
//
// Only the first signal counts: one session end is reported once; the clean exit it starts is
// idempotent anyway.
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'

export type SessionEndSignal = 'SIGTERM' | 'SIGHUP'

/** One process signal taken as an OS session end on one OS. */
export interface SessionEndSource {
  signal: SessionEndSignal
  /** False while nobody has observed this OS deliver it at logout or shutdown. */
  verified: boolean
}

const POSIX_SOURCES: readonly SessionEndSource[] = Object.freeze([
  { signal: 'SIGTERM', verified: false },
  { signal: 'SIGHUP', verified: false }
])

const WINDOWS_SOURCES: readonly SessionEndSource[] = Object.freeze([
  { signal: 'SIGHUP', verified: false }
])

/** The signals taken as a session end on `platform`. */
export function sessionEndSources(platform: NodeJS.Platform): readonly SessionEndSource[] {
  return platform === 'win32' ? WINDOWS_SOURCES : POSIX_SOURCES
}

/** The part of `process` this adapter listens on. */
export interface SignalEmitter {
  once(signal: SessionEndSignal, listener: () => void): unknown
}

export interface OsSessionSignalsDeps {
  platform: NodeJS.Platform
  emitter: SignalEmitter
  log: DiagnosticsLog
}

export interface OsSessionSignals {
  onSessionEnd(listener: () => void): void
}

export function osSessionSignals(deps: OsSessionSignalsDeps): OsSessionSignals {
  const listeners: Array<() => void> = []
  let ended = false
  for (const source of sessionEndSources(deps.platform)) {
    deps.emitter.once(source.signal, () => {
      if (ended) return
      ended = true
      if (!source.verified) {
        deps.log.record({
          level: 'warn',
          event: 'host.os-session-end',
          subsystem: 'host',
          causeClass: source.signal,
          outcome: 'degraded',
          msg: `UNVERIFIED session-end source ${source.signal} fired`
        })
      }
      for (const listener of listeners) listener()
    })
  }
  return { onSessionEnd: (listener) => listeners.push(listener) }
}

/** The adapter over this Host process's own signals. */
export function nodeOsSessionSignals(log: DiagnosticsLog): OsSessionSignals {
  return osSessionSignals({ platform: process.platform, emitter: process, log })
}
