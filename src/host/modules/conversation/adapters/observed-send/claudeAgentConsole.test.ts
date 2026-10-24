// layer: L1
// L1 (17 §1.1): the pure reader of a Claude Code lead terminal's screen (AMENDMENT-29), over the
// Claude Code 2.1.310 screens of fixtures/claude/observer/2.1.310 (reconstructed from the spike
// record, see its meta.json). Every screen it cannot read positively is null: the route refuses.
import { describe, expect, it } from 'vitest'
import { readAgentConsole } from './claudeAgentConsole'
import { agentConsoleScreen as screen } from './testing/agentConsoleScreens'

const ROWS = [
  { label: 'main' },
  { label: 'Run ping five times (delta)' },
  { label: 'Running ping loop, run 2 of 5' },
  { label: 'Run ping five times (foxtrot)' }
]

describe('readAgentConsole: what the lead terminal shows (Claude Code 2.1.310)', () => {
  it('[ADR-012] the lead view with an empty input: no view label, the agent list with main first, no pointer', () => {
    expect(readAgentConsole(screen('lead-input-empty'))).toEqual({
      viewLabel: null,
      inputEmpty: true,
      rows: ROWS,
      selected: null
    })
  })

  it("[ADR-012] a person's draft in the lead input is not empty, on one line or on several", () => {
    expect(readAgentConsole(screen('lead-input-draft'))?.inputEmpty).toBe(false)
    expect(readAgentConsole(screen('lead-input-multiline-draft'))?.inputEmpty).toBe(false)
  })

  it('[ADR-012] the list pointer names the selected row, main included', () => {
    expect(readAgentConsole(screen('lead-list-main'))?.selected).toBe(0)
    expect(readAgentConsole(screen('lead-list-echo'))?.selected).toBe(2)
  })

  it("[ADR-012] a subagent view: the rule label is that subagent's description, the placeholder alone is an empty input", () => {
    expect(readAgentConsole(screen('view-echo-list'))).toEqual({
      viewLabel: 'Run ping five times (echo)',
      inputEmpty: true,
      rows: ROWS,
      selected: 2
    })
    expect(readAgentConsole(screen('view-echo-draft'))?.inputEmpty).toBe(false)
  })

  it('[ADR-012] the placeholder words typed into the lead view are a draft, not an empty input', () => {
    const lines = screen('lead-input-empty').map((line) =>
      line === '❯' ? '❯ Message @general-purpose' : line
    )
    expect(readAgentConsole(lines)?.inputEmpty).toBe(false)
  })

  it('[ADR-012] no running subagent: the list is empty', () => {
    expect(readAgentConsole(screen('lead-no-agents'))).toEqual({
      viewLabel: null,
      inputEmpty: true,
      rows: [],
      selected: null
    })
  })

  it('[ADR-012] blank rows under the window content change nothing', () => {
    const lines = [...screen('view-echo-list'), '', '', '']
    expect(readAgentConsole(lines)).toEqual(readAgentConsole(screen('view-echo-list')))
  })

  it('[ADR-012] a screen that is not the measured layout is not read at all', () => {
    expect(readAgentConsole(screen('unrecognised'))).toBeNull()
    expect(readAgentConsole([])).toBeNull()
    // The input box without its bottom rule, or a pointer on two rows, is no layout it knows.
    const lead = screen('lead-list-echo')
    expect(readAgentConsole(lead.filter((_, index) => index !== 4))).toBeNull()
    expect(
      readAgentConsole(
        lead.map((line) =>
          line.replace(/^ {2}● Run ping five times \(delta\)/, '❯ ● Run ping five times (delta)')
        )
      )
    ).toBeNull()
  })
})
