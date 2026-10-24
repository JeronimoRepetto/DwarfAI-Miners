// layer: L1
// L1 (17 §1.1): the pure Windows builders of the observed-subagent route (AMENDMENT-29; spike helper
// scripts/spikes/claude-subagent-input/console.mjs, commit 867dad5d): the screen read on `CONOUT$`
// and the three navigation keys on `CONIN$`, each one call of its own. Esc has no record.
import { describe, expect, it } from 'vitest'
import {
  navKeyRecordOf,
  screenLinesOf,
  windowsNavKeyScript,
  windowsScreenReadScript
} from './consoleScreen'
import type { NavKey } from './claudeAgentPlan'

const base64Utf16 = (text: string) => Buffer.from(text, 'utf16le').toString('base64')

describe('windowsScreenReadScript: reads the visible window of one console, writes nothing', () => {
  it('[ADR-012, ADR-014] attaches to that pid, opens CONOUT$ only, and prints the window as base64 of UTF-16', () => {
    const script = windowsScreenReadScript(4242)!
    expect(script).toContain('AttachConsole(4242)')
    expect(script).toContain("'CONOUT$'")
    expect(script).not.toContain('CONIN$')
    expect(script).not.toContain('WriteConsole')
    expect(script).toContain('ReadConsoleOutputCharacterW')
    expect(script).toContain('[Convert]::ToBase64String')
  })

  it('[ADR-014] a pid that cannot name a process gets no script', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(windowsScreenReadScript(pid)).toBeNull()
  })

  it('[ADR-012] the printed screen reads back as its rows, glyphs intact (no code page in between)', () => {
    const rows = ['─── Run ping five times (echo) ─', '❯ Message @general-purpose', '  ● é ✓']
    expect(screenLinesOf(`${base64Utf16(rows.join('\n'))}\r\n`)).toEqual(rows)
    expect(screenLinesOf('')).toBeNull()
    expect(screenLinesOf('not base64 !')).toBeNull()
  })
})

describe('windowsNavKeyScript: one navigation key per call, never Esc', () => {
  it('[ADR-012] ↓, ↑ and Enter are their virtual keys, Enter with its carriage return (spike §Setup)', () => {
    expect(navKeyRecordOf('down')).toEqual({ virtualKey: 0x28, unit: 0 })
    expect(navKeyRecordOf('up')).toEqual({ virtualKey: 0x26, unit: 0 })
    expect(navKeyRecordOf('enter')).toEqual({ virtualKey: 0x0d, unit: 0x0d })
  })

  it('[ADR-012] Esc, x, a letter or any other name has no record and no script', () => {
    for (const key of ['escape', 'esc', 'x', 'left', 'tab', '']) {
      expect(navKeyRecordOf(key as NavKey)).toBeNull()
      expect(windowsNavKeyScript(4242, key as NavKey)).toBeNull()
    }
  })

  it('[ADR-012, ADR-014] one key into CONIN$ of that pid, down then up, in one WriteConsoleInputW call', () => {
    const script = windowsNavKeyScript(4242, 'down')!
    expect(script).toContain('AttachConsole(4242)')
    expect(script).toContain("'CONIN$'")
    expect(script).toContain('[uint16]40')
    expect(script).toContain('WriteConsoleInputW($conin, $buffer, [uint32]2')
    expect(windowsNavKeyScript(0, 'down')).toBeNull()
  })

  it('[ADR-012] no script ever carries the Esc virtual key or character', () => {
    for (const key of ['down', 'up', 'enter'] as const) {
      expect(windowsNavKeyScript(4242, key)).not.toMatch(/\[uint16\]27\b/)
    }
  })
})
