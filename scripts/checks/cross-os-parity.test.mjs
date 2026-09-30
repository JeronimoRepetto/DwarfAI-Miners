import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PARITY_SKIP_NOTICE, compareParityReports, runCrossOsParity } from './cross-os-parity.mjs'

/**
 * L7 check of cross-OS parity (BR-24: anything a person can see differ between Windows, macOS and
 * Linux is a defect; NFR-PLAT-01).
 *
 * Each OS leg of a golden run writes a report of what a person can see per screen: its visible
 * texts and its controls. The check compares the three legs and fails on any screen whose report
 * differs, naming the screen, the field and the legs.
 */

const screen = (visibleText, controls) => ({ visibleText, controls })

const report = (screens) => ({ screens })

const PANEL = screen(['Mine', 'Crew'], ['button:Add dwarf', 'tab:Crew'])
const SETTINGS = screen(['Settings'], ['switch:Start with the system'])

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

function collectingIo() {
  const lines = { out: [], err: [] }
  return {
    lines,
    io: { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) }
  }
}

describe('cross-OS parity of the golden run (BR-24)', () => {
  it('[BR-24, NFR-PLAT-01] a golden run whose visible-text and control report differs between the Windows, macOS and Linux legs fails the parity check; identical reports pass', () => {
    const same = report({ panel: PANEL, settings: SETTINGS })
    expect(compareParityReports({ win32: same, darwin: same, linux: same })).toEqual([])

    const textDiffers = compareParityReports({
      win32: same,
      darwin: report({ panel: screen(['Mine', 'Crew…'], PANEL.controls), settings: SETTINGS }),
      linux: same
    })
    expect(textDiffers).toHaveLength(1)
    expect(textDiffers[0]).toMatch(/panel/)
    expect(textDiffers[0]).toMatch(/visibleText/)
    expect(textDiffers[0]).toMatch(/darwin/)

    const controlDiffers = compareParityReports({
      win32: same,
      darwin: same,
      linux: report({ panel: PANEL, settings: screen(SETTINGS.visibleText, []) })
    })
    expect(controlDiffers).toHaveLength(1)
    expect(controlDiffers[0]).toMatch(/settings/)
    expect(controlDiffers[0]).toMatch(/controls/)
    expect(controlDiffers[0]).toMatch(/linux/)

    const screenMissing = compareParityReports({
      win32: report({ panel: PANEL }),
      darwin: same,
      linux: same
    })
    expect(screenMissing.join('\n')).toMatch(/settings.*missing on win32/)
  })

  it('[BR-24] the command compares the three legs of a report folder and skips with a notice when there is none', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cross-os-parity-'))
    tempRoots.push(root)

    const absent = collectingIo()
    expect(runCrossOsParity(['--reports', path.join(root, 'absent')], absent.io)).toBe(0)
    expect(absent.lines.out).toEqual([PARITY_SKIP_NOTICE])

    const dir = path.join(root, 'parity')
    mkdirSync(dir)
    const same = JSON.stringify(report({ panel: PANEL }))
    writeFileSync(path.join(dir, 'win32.json'), same)
    writeFileSync(path.join(dir, 'darwin.json'), same)
    const oneLegMissing = collectingIo()
    expect(runCrossOsParity(['--reports', dir], oneLegMissing.io)).toBe(1)
    expect(oneLegMissing.lines.err.join('\n')).toMatch(/linux\.json/)

    writeFileSync(path.join(dir, 'linux.json'), same)
    expect(runCrossOsParity(['--reports', dir], collectingIo().io)).toBe(0)

    writeFileSync(path.join(dir, 'linux.json'), JSON.stringify(report({ panel: SETTINGS })))
    const differs = collectingIo()
    expect(runCrossOsParity(['--reports', dir], differs.io)).toBe(1)
    expect(differs.lines.err.join('\n')).toMatch(/panel/)
  })
})
