// layer: L7
import { describe, expect, it } from 'vitest'
import { compareFuses, FUSE_SENTINEL, readFuseWire, RECORDED_FUSE_SET } from './fuses.mjs'

/** A fake binary: some bytes, the sentinel, the wire version and length, the states, more bytes. */
function binaryWith(states, { version = 1, copies = 1 } = {}) {
  const wire = Buffer.concat([
    Buffer.from(FUSE_SENTINEL, 'latin1'),
    Buffer.from([version, states.length]),
    Buffer.from(states, 'latin1')
  ])
  const parts = [Buffer.from('MZ padding before the wire')]
  for (let i = 0; i < copies; i++) parts.push(wire, Buffer.from('between'))
  return Buffer.concat(parts)
}

describe('fuse wire reader (ADR-019 item 5; S-019-2)', () => {
  it('[S-019-2, ADR-019] reads each fuse of the wire by name, with its state', () => {
    const wire = readFuseWire(binaryWith('10011100'))
    expect(wire.found).toBe(true)
    expect(wire.version).toBe(1)
    expect(wire.sentinels).toBe(1)
    expect(wire.fuses).toEqual([
      { index: 0, name: 'RunAsNode', state: 'enabled' },
      { index: 1, name: 'EnableCookieEncryption', state: 'disabled' },
      { index: 2, name: 'EnableNodeOptionsEnvironmentVariable', state: 'disabled' },
      { index: 3, name: 'EnableNodeCliInspectArguments', state: 'enabled' },
      { index: 4, name: 'EnableEmbeddedAsarIntegrityValidation', state: 'enabled' },
      { index: 5, name: 'OnlyLoadAppFromAsar', state: 'enabled' },
      { index: 6, name: 'LoadBrowserProcessSpecificV8Snapshot', state: 'disabled' },
      { index: 7, name: 'GrantFileProtocolExtraPrivileges', state: 'disabled' }
    ])
  })

  it('[S-019-2] names a fuse past the known ones by its index and reports removed and unknown states', () => {
    const wire = readFuseWire(binaryWith('1r0000001\x90'))
    expect(wire.fuses[1]).toEqual({ index: 1, name: 'EnableCookieEncryption', state: 'removed' })
    expect(wire.fuses[8]).toEqual({ index: 8, name: 'fuse-8', state: 'enabled' })
    expect(wire.fuses[9]).toEqual({ index: 9, name: 'fuse-9', state: 'unknown-0x90' })
  })

  it('[S-019-2] reports a binary without the sentinel as not found, and counts the slices of a universal binary', () => {
    expect(readFuseWire(Buffer.from('no electron here'))).toEqual({
      found: false,
      version: null,
      sentinels: 0,
      fuses: []
    })
    const universal = readFuseWire(binaryWith('10', { copies: 2 }))
    expect(universal.sentinels).toBe(2)
    expect(universal.slicesAgree).toBe(true)
  })

  it('[S-019-2, ADR-019] compares a wire with the ADR-019 item 5 set and lists every difference', () => {
    const fused = readFuseWire(binaryWith('11001100'))
    expect(compareFuses(fused.fuses, RECORDED_FUSE_SET)).toEqual([])
    const stock = readFuseWire(binaryWith('10110001'))
    expect(compareFuses(stock.fuses, RECORDED_FUSE_SET)).toEqual([
      { name: 'EnableCookieEncryption', expected: 'enabled', actual: 'disabled' },
      { name: 'EnableNodeOptionsEnvironmentVariable', expected: 'disabled', actual: 'enabled' },
      { name: 'EnableNodeCliInspectArguments', expected: 'disabled', actual: 'enabled' },
      { name: 'EnableEmbeddedAsarIntegrityValidation', expected: 'enabled', actual: 'disabled' },
      { name: 'OnlyLoadAppFromAsar', expected: 'enabled', actual: 'disabled' }
    ])
    expect(compareFuses([], { RunAsNode: 'enabled' })).toEqual([
      { name: 'RunAsNode', expected: 'enabled', actual: 'absent' }
    ])
  })
})
