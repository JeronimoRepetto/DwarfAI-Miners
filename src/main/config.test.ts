import { describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig } from './config'

describe('defaultConfig', () => {
  it('returns the documented defaults', () => {
    expect(defaultConfig()).toEqual({ pollIntervalMs: 2000, livenessWindowS: 90 })
  })

  it('returns a fresh object on every call', () => {
    expect(defaultConfig()).not.toBe(defaultConfig())
  })
})

describe('loadConfig', () => {
  it('returns defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual(defaultConfig())
  })

  it('treats empty or blank values as unset', () => {
    expect(loadConfig({ POLL_INTERVAL_MS: '', LIVENESS_WINDOW_S: '   ' })).toEqual(defaultConfig())
  })

  it('parses valid integer values', () => {
    const config = loadConfig({ POLL_INTERVAL_MS: '5000', LIVENESS_WINDOW_S: '120' })
    expect(config).toEqual({ pollIntervalMs: 5000, livenessWindowS: 120 })
  })

  it('applies defaults per key independently', () => {
    expect(loadConfig({ POLL_INTERVAL_MS: '250' })).toEqual({
      pollIntervalMs: 250,
      livenessWindowS: 90
    })
  })

  it('fails fast on a non-numeric value', () => {
    expect(() => loadConfig({ POLL_INTERVAL_MS: 'abc' })).toThrowError(/POLL_INTERVAL_MS/)
  })

  it('fails fast on zero', () => {
    expect(() => loadConfig({ POLL_INTERVAL_MS: '0' })).toThrowError(/POLL_INTERVAL_MS/)
  })

  it('fails fast on negative values', () => {
    expect(() => loadConfig({ LIVENESS_WINDOW_S: '-5' })).toThrowError(/LIVENESS_WINDOW_S/)
  })

  it('fails fast on non-integer values', () => {
    expect(() => loadConfig({ LIVENESS_WINDOW_S: '90.5' })).toThrowError(/LIVENESS_WINDOW_S/)
  })
})
