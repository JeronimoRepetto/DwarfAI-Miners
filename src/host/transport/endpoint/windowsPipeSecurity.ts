// The Windows half of ADR-003 item 2 (frozen): the hand-off between the endpoint server and the
// native pipe helper that spike SP-05 made mandatory (spike-results/SP-05.md).
//
// SP-05 measured that a pipe created by Node gets libuv's default security descriptor, which
// grants read to Everyone and to Anonymous, and that Node cannot serve a pipe another process
// created (libuv opens a server's first instance as the first instance of its name). ADR-003 item
// 2 then says a small native helper MUST create the pipe with the protected DACL. The helper is an
// in-process native module (host/platform/endpoint/win-pipe, owner decision 2026-10-01): it creates
// every instance of the pipe with `D:P(D;;GA;;;NU)(A;;GA;;;<user SID>)(A;;GA;;;SY)` and
// PIPE_REJECT_REMOTE_CLIENTS, waits for each client, and hands the connected pipe to Node as a
// socket; Node does all the I/O.
//
// The endpoint server receives the helper as a `ListenOwnerOnlyPipe` from host/wiring. A named-pipe
// endpoint is never served without it: when the helper is missing or cannot load, the bind fails
// with PIPE_ACL_UNAVAILABLE and the boot logs it (ISSUE-022 TC-022-05; 13 FM-036). There is no
// fallback to Node's own pipe, whose default DACL ADR-003 item 2 rules out once SP-05 showed it
// readable by other users.
import type { Socket } from 'node:net'

/** The bind error of a named-pipe endpoint whose owner-only pipe helper is missing or unusable. */
export const PIPE_ACL_UNAVAILABLE = 'ENDPOINT_PIPE_ACL_UNAVAILABLE'

/** The code of a pipe name that already has an instance: the ADR-002 D3 mutex is held. */
export const PIPE_NAME_IN_USE = 'EADDRINUSE'

export interface OwnerOnlyPipeHandlers {
  /** A client connected; the socket is the caller's from now on. */
  onConnection(socket: Socket): void
  /** Accepting failed after the pipe was created (for example out of handles); listening goes on. */
  onError(code: string): void
}

export interface OwnerOnlyPipeServer {
  /**
   * Stops accepting: the waiting instances are closed and the name is free again once every
   * connection handed over has ended. Connections handed over stay the caller's to end.
   */
  close(): Promise<void>
}

export type OwnerOnlyPipeListen =
  | { ok: true; server: OwnerOnlyPipeServer }
  /**
   * `code` is PIPE_NAME_IN_USE, PIPE_ACL_UNAVAILABLE or another bind failure. `causeClass` is a
   * fixed name for why the helper is unavailable, which the boot logs.
   */
  | { ok: false; code: string; causeClass?: string }

/**
 * Creates the named pipe `name` owner-only (ADR-003 item 2) as the first instance of its name and
 * hands every connected client over as a socket.
 */
export type ListenOwnerOnlyPipe = (
  name: string,
  handlers: OwnerOnlyPipeHandlers
) => Promise<OwnerOnlyPipeListen>
