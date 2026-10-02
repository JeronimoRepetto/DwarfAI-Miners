import { describe, expect, it } from 'vitest'
import { createLegacyDiagnostics, type LegacyLogEntry } from './legacyDiagnostics'

// L1 (17 §1.1): what today's runtime, composed through LegacyRuntimeRoute, writes to the UI log
// instead of the console (ADR-026 items 3–5; 19 §1 items 1–2, §7). Every record is an allowlisted
// event with identifier fields only: the message text and the error's message never reach it.

function recorder() {
  const entries: LegacyLogEntry[] = []
  return { entries, diagnostics: createLegacyDiagnostics({ record: (e) => void entries.push(e) }) }
}

/** Values a legacy warning carries today that the log must never hold (19 §7). */
const FORBIDDEN = ['C:\Users\j', '/home/j', 'sk-canary0123456789abcdef', 'please fix the parser']

describe('legacy runtime diagnostics (ADR-026, 19 §7)', () => {
  it('[ADR-026, NFR-OBS-01] a warning of today runtime is one legacy.warning record with its area as class and the error code only', () => {
    const r = recorder()
    const error = Object.assign(new Error(`EACCES: open ${FORBIDDEN[0]}\config.json`), {
      code: 'EACCES'
    })

    r.diagnostics.warning('config', error)
    r.diagnostics.warning('hooks', `listener failed on ${FORBIDDEN[1]}/x: ${FORBIDDEN[3]}`)
    r.diagnostics.warning('jev-key', new TypeError(`bad key ${FORBIDDEN[2]}`))
    r.diagnostics.warning('autostart')

    expect(r.entries).toEqual([
      {
        level: 'warn',
        event: 'legacy.warning',
        subsystem: 'legacy-runtime',
        causeClass: 'config',
        errCode: 'EACCES'
      },
      { level: 'warn', event: 'legacy.warning', subsystem: 'legacy-runtime', causeClass: 'hooks' },
      {
        level: 'warn',
        event: 'legacy.warning',
        subsystem: 'legacy-runtime',
        causeClass: 'jev-key',
        errCode: 'TypeError'
      },
      {
        level: 'warn',
        event: 'legacy.warning',
        subsystem: 'legacy-runtime',
        causeClass: 'autostart'
      }
    ])
    const written = JSON.stringify(r.entries)
    for (const value of FORBIDDEN) expect(written).not.toContain(value)
  })

  it('[ADR-026, FM-053] a preference that could not be written is the 19 §9.6 uiprefs.write-failed record, its store name as msg', () => {
    const r = recorder()

    r.diagnostics.preferenceWriteFailed(
      'typography',
      Object.assign(new Error(`ENOSPC: write ${FORBIDDEN[0]}\typography.json`), {
        code: 'ENOSPC'
      })
    )
    r.diagnostics.preferenceWriteFailed('pin', 'not an error')

    expect(r.entries).toEqual([
      {
        level: 'warn',
        event: 'uiprefs.write-failed',
        subsystem: 'legacy-runtime',
        msg: 'typography',
        errCode: 'ENOSPC'
      },
      { level: 'warn', event: 'uiprefs.write-failed', subsystem: 'legacy-runtime', msg: 'pin' }
    ])
    expect(JSON.stringify(r.entries)).not.toContain(FORBIDDEN[0])
  })

  it('[ADR-026] an error code that is not an identifier falls back to the class name, never to the text', () => {
    const r = recorder()

    r.diagnostics.warning(
      'mine-path',
      Object.assign(new RangeError('x'), { code: `failed at ${FORBIDDEN[1]}` })
    )

    expect(r.entries).toEqual([
      expect.objectContaining({ causeClass: 'mine-path', errCode: 'RangeError' })
    ])
  })
})
