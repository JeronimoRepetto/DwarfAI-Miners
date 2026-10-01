// The UI writer's own record rules, applied before the pure `toLogLine` (the ISSUE-012 split, recorded in
// contracts/logging/canary.test.ts): `toLogLine` guarantees the shaped fields, `stack`, and credential and home
// values in `msg`/`errCode`; the free-string fields whose owners declare a plain `string` are kept free of content
// by each writer. The UI tree may not import the Host's rules (R10), so it holds the same identifier shapes here,
// each from its owner's description (ADR-026 items 3–4): a name, a sentence, a path or a payload cannot take one.
import { redactSecrets, type LogRecord } from '@dwarfai/contracts'

export type UiRecordRefusal = 'sensitive' | 'field-not-allowed'

/** Fields the writer fills; an entry that carries one is refused. */
const WRITER_FIELDS = [
  'ts',
  'proc',
  'pid',
  'appVersion'
] as const satisfies readonly (keyof LogRecord)[]

/**
 * Identifier shapes of the free-string fields:
 * - `subsystem`: "module name (ADR-004)", a lower-case module id (`window`, `diagnostics`, `host-client`);
 * - `causeClass`: a typed cause the code already has (19 §1 item 3), such as an Electron `render-process-gone`
 *   reason (`crashed`, `oom`);
 * - `errCode`: "errno / JSON-RPC code" or an error class name, the shape 19 §9.6 gives renderer error codes;
 * - `providerVersion`: a provider's version string (NFR-OBS-04);
 * - `method`: a seam-A member name or a seam-B method or frame name;
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
 * `msg` is "a fixed developer sentence" (ADR-026 item 3): one line of plain text. Line breaks and control
 * characters (a tool-output tail), quotes and brackets (a payload) and path separators (a mine or file path,
 * ADR-026 item 4) never belong in one.
 */
const MSG_FORBIDDEN = /[\u0000-\u001f\u007f\\/"`{}[\]]/

/** Why the UI writer refuses `entry` before `toLogLine`, or `null` when it may go on. */
export function uiRecordRefusal(entry: unknown): UiRecordRefusal | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'sensitive'
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
