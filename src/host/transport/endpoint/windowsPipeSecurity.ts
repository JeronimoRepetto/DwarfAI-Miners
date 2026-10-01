// The Windows half of ADR-003 item 2 (frozen), as spike SP-05 left it (spike-results/SP-05.md).
//
// SP-05 measured that a pipe created by Node gets libuv's default security descriptor, which
// grants read (FILE_GENERIC_READ) to Everyone and to Anonymous, and adopted ADR-003 item 2's own
// fallback: a small native helper creates the pipe with the protected DACL
// `D:P(D;;GA;;;NU)(A;;GA;;;<user SID>)(A;;GA;;;SY)` and PIPE_REJECT_REMOTE_CLIENTS.
//
// Node cannot serve a pipe that another process created: libuv opens a server's first instance as
// the first instance of its name, so `listen` on a name that already has an instance fails with
// EADDRINUSE (measured on Windows 11 with Node 24.11.1, 2026-10-01, against an instance created by
// .NET). The helper therefore cannot simply create the pipe and leave it to Node, and how its pipe
// reaches the Host (a relay process, a native module, or another design) is not decided anywhere in
// the package: ISSUE-022 reports the Windows half BLOCKED on that decision.
//
// Until the helper exists the pipe is Node's, and ADR-003 item 2's interim rule is the control:
// the token handshake (later: ISSUE-023) is binding, and the Host sends no byte to a connection
// before it has authenticated. With read access only, another local user or a remote client can
// open the pipe but can never write a `hello`, so it can never authenticate and never receives a
// byte. The interim is never silent (ISSUE-022 TC-022-05; 13 FM-036): every Windows bind logs it
// as degraded.
import type { DiagnosticEntry } from '../../kernel/ports/diagnosticsLog'

/** The record every Windows bind writes while the pipe has Node's default DACL. */
export const INTERIM_PIPE_ACL_RECORD: Readonly<DiagnosticEntry> = Object.freeze({
  level: 'warn',
  event: 'host.endpoint.acl',
  subsystem: 'host',
  outcome: 'degraded',
  causeClass: 'sp05-helper-pending',
  msg: 'the UI pipe has the default DACL until the SP-05 pipe helper exists; the token handshake is the binding control and no byte is sent before authentication'
})
