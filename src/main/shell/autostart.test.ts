import { describe, expect, it, vi } from 'vitest'
import { ensureDefaultAutostart, planAutostartMigration } from './autostart'

describe('ensureDefaultAutostart', () => {
  it('does nothing in development', async () => {
    const enable = vi.fn(async () => undefined)
    const exists = vi.fn(async () => false)
    await ensureDefaultAutostart({
      isPackaged: false,
      markerPath: 'marker',
      enable,
      fileExists: exists
    })
    expect(enable).not.toHaveBeenCalled()
    expect(exists).not.toHaveBeenCalled()
  })

  it('enables and writes the marker on the first packaged launch', async () => {
    const events: string[] = []
    await ensureDefaultAutostart({
      isPackaged: true,
      markerPath: 'marker',
      enable: async () => {
        events.push('enable')
      },
      fileExists: async () => false,
      writeMarker: async () => {
        events.push('marker')
      }
    })
    expect(events).toEqual(['enable', 'marker'])
  })

  it('does not re-enable when the marker already exists', async () => {
    const enable = vi.fn(async () => undefined)
    const writeMarker = vi.fn(async () => undefined)
    await ensureDefaultAutostart({
      isPackaged: true,
      markerPath: 'marker',
      enable,
      fileExists: async () => true,
      writeMarker
    })
    expect(enable).not.toHaveBeenCalled()
    expect(writeMarker).not.toHaveBeenCalled()
  })

  it('does not write the marker when registry enable fails and warns', async () => {
    const writeMarker = vi.fn(async () => undefined)
    const warn = vi.fn()
    await ensureDefaultAutostart({
      isPackaged: true,
      markerPath: 'marker',
      enable: async () => {
        throw new Error('registry unavailable')
      },
      fileExists: async () => false,
      writeMarker,
      warn
    })
    expect(writeMarker).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('planAutostartMigration', () => {
  it('does nothing when the legacy value is absent and autostart is off', () => {
    expect(planAutostartMigration({ legacyValuePresent: false, autostartEnabled: false })).toEqual({
      deleteLegacy: false,
      writeNew: false
    })
  })

  it('does nothing when the legacy value is absent, even if autostart reads as on', () => {
    // Cannot happen through the real registry (the legacy value's presence is
    // the only "was enabled" signal), but the pure function must not invent
    // a legacy value to delete just because autostart is on.
    expect(planAutostartMigration({ legacyValuePresent: false, autostartEnabled: true })).toEqual({
      deleteLegacy: false,
      writeNew: false
    })
  })

  it('removes a stale legacy value without re-enabling autostart when it was off', () => {
    expect(planAutostartMigration({ legacyValuePresent: true, autostartEnabled: false })).toEqual({
      deleteLegacy: true,
      writeNew: false
    })
  })

  it('migrates the legacy value to the new name when autostart was on', () => {
    expect(planAutostartMigration({ legacyValuePresent: true, autostartEnabled: true })).toEqual({
      deleteLegacy: true,
      writeNew: true
    })
  })
})
