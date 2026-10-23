// The Electron fuse wire reader (ADR-019 item 5; spike S-019-2; read by P-01, the fuse release check of `20` §2.3).
//
// Electron keeps its fuses in the binary as a wire: a fixed 32-byte sentinel, one byte for the wire version, one byte
// for the number of fuses, then one byte per fuse: '0' disabled, '1' enabled, 'r' removed. On macOS the wire lives in
// `Contents/Frameworks/Electron Framework.framework/Electron Framework`; on Windows and Linux in the app executable. A
// universal macOS binary holds two copies, one per slice. This module reads the bytes it is given and nothing else, so
// it needs no dependency (the format is the one @electron/fuses 1.8 writes, MIT).
import { loadExpectedFuses } from '../fuses.mjs'

/** The sentinel that precedes the fuse wire in every Electron binary since Electron 12. */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'

/** The V1 fuse names, by wire index (@electron/fuses `FuseV1Options`). */
export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges'
]

/**
 * The fuse set ADR-019 item 5 records, read from scripts/release/fuses.expected.json (the per-target record of S-019-2
 * that the fuse step flips and P-01 asserts). `RunAsNode` stays enabled because the Host runs the app executable with
 * `ELECTRON_RUN_AS_NODE` (ADR-002). A target's known limits live beside it in that file (`expectedFusesFor`).
 */
export const RECORDED_FUSE_SET = loadExpectedFuses().fuses

const STATES = { 0x30: 'disabled', 0x31: 'enabled', 0x72: 'removed' }

function stateOf(byte) {
  return STATES[byte] ?? `unknown-0x${byte.toString(16).padStart(2, '0')}`
}

function wireAt(buffer, sentinelAt) {
  const at = sentinelAt + FUSE_SENTINEL.length
  const version = buffer[at]
  const length = buffer[at + 1] ?? 0
  const fuses = []
  for (let i = 0; i < length && at + 2 + i < buffer.length; i++) {
    fuses.push({ index: i, name: FUSE_NAMES[i] ?? `fuse-${i}`, state: stateOf(buffer[at + 2 + i]) })
  }
  return { version, fuses }
}

/**
 * The fuse wire of a binary: `{ found, version, sentinels, fuses: [{ index, name, state }] }`, plus `slicesAgree`
 * when the binary holds more than one wire (a universal macOS binary). The first wire is the one reported.
 */
export function readFuseWire(buffer) {
  const sentinel = Buffer.from(FUSE_SENTINEL, 'latin1')
  const positions = []
  for (let at = buffer.indexOf(sentinel); at !== -1; at = buffer.indexOf(sentinel, at + 1)) {
    positions.push(at)
  }
  if (positions.length === 0) return { found: false, version: null, sentinels: 0, fuses: [] }
  const wires = positions.map((at) => wireAt(buffer, at))
  const first = wires[0]
  const result = {
    found: true,
    version: first.version,
    sentinels: positions.length,
    fuses: first.fuses
  }
  if (wires.length > 1) {
    result.slicesAgree = wires.every((wire) => JSON.stringify(wire) === JSON.stringify(first))
  }
  return result
}

/** Every fuse of `expected` (`{ name: state }`) whose state in `fuses` differs, in the order of `expected`. */
export function compareFuses(fuses, expected) {
  const byName = new Map(fuses.map((fuse) => [fuse.name, fuse.state]))
  return Object.entries(expected)
    .filter(([name, state]) => byName.get(name) !== state)
    .map(([name, state]) => ({ name, expected: state, actual: byName.get(name) ?? 'absent' }))
}
