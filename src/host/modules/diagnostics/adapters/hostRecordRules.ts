// The Host writer's own record rules, applied before the pure `toLogLine` (the ISSUE-012 split,
// recorded in contracts/logging/canary.test.ts): `toLogLine` guarantees the shaped fields, `stack`,
// and credential and home values in `msg`/`errCode`; the free-string fields whose owners declare a
// plain `string` are kept free of content by each writer. In the Host these fields name things the
// code owns (a module, a typed cause, an errno or JSON-RPC code, a version, a method, an opaque id),
// so each is held to an identifier shape that a name, a sentence, a path or a payload cannot take
// (ADR-026 items 3–4).
import { redactSecrets } from '../../../../contracts/logging'

export type HostRecordRefusal = 'sensitive' | 'field-not-allowed'

/** Fields the writer fills (16 §3 `DiagnosticEntry`); an entry that carries one is refused. */
const WRITER_FIELDS = ['ts', 'proc', 'pid', 'appVersion'] as const

/**
 * Identifier shapes of the free-string fields, each from its owner's description:
 * - `subsystem`: "module name (ADR-004)", the lower-case module ids of 05 §1.1;
 * - `causeClass`: a typed cause the code already has (19 §1 item 3), such as `exited-at-once`;
 * - `errCode`: "errno / JSON-RPC code" (`ENOENT`, `-32602`, an exit code), the shape 19 §9.6
 *   gives renderer error codes;
 * - `providerVersion`: a provider's version string (NFR-OBS-04), such as `2.1.261`;
 * - `method`: a seam-B method or frame name or a seam-A member name (`conversation.send`);
 * - `hostEpoch`, `connId`: opaque ids (ADR-003 `HelloOk.epoch`, `clientId`).
 */
const SHAPES: Readonly<Record<string, RegExp>> = {
  subsystem: /^[a-z][a-z0-9-]{0,63}$/,
  causeClass: /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/,
  errCode: /^[A-Za-z0-9_.:-]{1,64}$/,
  providerVersion: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/,
  method: /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/,
  hostEpoch: /^[A-Za-z0-9_-]{1,128}$/,
  connId: /^[A-Za-z0-9_-]{1,128}$/
}

/**
 * `msg` is "a fixed developer sentence" (ADR-026 item 3): one line of plain text. Line breaks and
 * control characters (a tool-output tail), quotes and brackets (a payload) and path separators
 * (a mine or file path, ADR-026 item 4) never belong in one.
 */
const MSG_FORBIDDEN = /[\u0000-\u001f\u007f\\/"`{}[\]]/

/** Why the Host writer refuses `entry` before `toLogLine`, or `null` when it may go on. */
export function hostRecordRefusal(entry: object): HostRecordRefusal | null {
  for (const field of WRITER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entry, field)) return 'field-not-allowed'
  }
  const fields = entry as Record<string, unknown>
  for (const [field, shape] of Object.entries(SHAPES)) {
    const value = fields[field]
    if (value === undefined) continue
    // A token is never an identifier (ADR-026 item 4), even when it fits the shape (64 hex digits).
    if (typeof value !== 'string' || !shape.test(value) || redactSecrets(value) !== value) {
      return 'sensitive'
    }
  }
  const msg = fields.msg
  if (msg !== undefined && (typeof msg !== 'string' || MSG_FORBIDDEN.test(msg))) return 'sensitive'
  return null
}

/** A build version (`x.y.z[-pre][+build]`), never free text and never a token (ADR-026 item 3). */
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

/** Whether `value` may fill the writer-owned `appVersion` of every line. */
export function isAppVersion(value: string): boolean {
  return APP_VERSION.test(value) && redactSecrets(value) === value
}
