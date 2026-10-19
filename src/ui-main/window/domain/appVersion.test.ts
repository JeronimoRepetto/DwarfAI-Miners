// layer: L1
import { describe, expect, it } from 'vitest'
import { isNewerAppVersion } from './appVersion'

/**
 * Whether a second launch is of a newer build than the running instance (AMENDMENT-25, 16 §4.14 as amended): SemVer
 * precedence, and only a well-formed version can be newer, so a launch that carries no version or a malformed one
 * keeps today's second-launch behaviour (ADR-002 D3).
 */
describe('a newer app version (AMENDMENT-25)', () => {
  it('[ADR-002, US-RES-008.AC03] a launch of a higher version is newer, by SemVer precedence', () => {
    expect(isNewerAppVersion('0.13.2', '0.13.1')).toBe(true)
    expect(isNewerAppVersion('0.14.0', '0.13.9')).toBe(true)
    expect(isNewerAppVersion('1.10.0', '1.9.0')).toBe(true)
    expect(isNewerAppVersion('2.0.0', '2.0.0-beta.10')).toBe(true)
  })

  it('[ADR-002, US-RES-008.AC03] an equal or older launch is not newer', () => {
    expect(isNewerAppVersion('0.13.1', '0.13.1')).toBe(false)
    expect(isNewerAppVersion('0.13.0', '0.13.1')).toBe(false)
    expect(isNewerAppVersion('1.9.0', '1.10.0')).toBe(false)
    expect(isNewerAppVersion('2.0.0-beta.10', '2.0.0')).toBe(false)
  })

  it('[ADR-002, US-RES-008.AC03] a launch without a version, or with one that is not a version, is never newer', () => {
    expect(isNewerAppVersion(undefined, '0.13.1')).toBe(false)
    expect(isNewerAppVersion('', '0.13.1')).toBe(false)
    expect(isNewerAppVersion('dev', '0.13.1')).toBe(false)
    expect(isNewerAppVersion('99', '0.13.1')).toBe(false)
  })
})
