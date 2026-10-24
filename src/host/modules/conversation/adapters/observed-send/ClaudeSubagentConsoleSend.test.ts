// layer: L3
// L3 (17 §1.3): the observed-subagent route (AMENDMENT-29, owner 2026-10-24) over the fake lead
// terminal (testing/FakeClaudeLeadConsole.ts), which draws the Claude Code 2.1.310 screens the spike
// measured and keeps the TUI's state. Proves: the message reaches the one subagent whose open view
// shows its description, the screen is read before every key, every doubt refuses before anything is
// typed, the lead view is restored, and the route has no way to press Esc. No real Claude anywhere.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { DwarfId } from '../../../../kernel/domain/values'
import { agentConsoleScreen } from './testing/agentConsoleScreens'
import {
  ClaudeSubagentConsoleSend,
  RECOGNISED_CLAUDE_VERSIONS,
  type SubagentSendFacts
} from './ClaudeSubagentConsoleSend'
import { FakeClaudeLeadConsole } from './testing/FakeClaudeLeadConsole'

const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId
const LEAD: ProcessIdentity = { pid: 4242, processStartTimeMs: 1_790_000_000_000, bootId: 'boot' }
const ECHO = 'Run ping five times (echo)'
const FOXTROT = 'Run ping five times (foxtrot)'
const TEXT = 'SPIKE-MARKER-7Q3X reply with the word marked.'

function route(
  facts: Partial<SubagentSendFacts> | null = {},
  console_ = new FakeClaudeLeadConsole(),
  platform: NodeJS.Platform = 'win32'
) {
  const asked: DwarfId[] = []
  const sender = new ClaudeSubagentConsoleSend({
    screen: console_,
    terminal: console_,
    platform,
    facts: {
      subagentSendFactsOf: async (dwarfId) => {
        asked.push(dwarfId)
        return facts === null
          ? null
          : { lead: LEAD, description: ECHO, twins: 0, version: '2.1.310', ...facts }
      }
    }
  })
  return { sender, tui: console_, asked }
}

/** The fake is back where the person left it: the lead's view, its input focused. */
function atLeadInput(console_: FakeClaudeLeadConsole): void {
  expect({ view: console_.view, focus: console_.focus }).toEqual({ view: 0, focus: 'input' })
}

describe('FakeClaudeLeadConsole draws the screens of fixtures/claude/observer/2.1.310', () => {
  it('[ADR-012] the lead view, the list on main, an open view and the input after a send match the fixture screens', () => {
    const console_ = new FakeClaudeLeadConsole()
    expect(console_.render()).toEqual(agentConsoleScreen('lead-input-empty'))
    console_.focus = 'list'
    expect(console_.render()).toEqual(agentConsoleScreen('lead-list-main'))
    console_.pointer = 2
    console_.view = 2
    expect(console_.render()).toEqual(agentConsoleScreen('view-echo-list'))
    console_.focus = 'input'
    expect(console_.render()).toEqual(agentConsoleScreen('view-echo-input-empty'))
  })
})

describe('ClaudeSubagentConsoleSend: the message reaches that subagent only', () => {
  it('[ADR-012, ADR-014] a row showing an activity summary: each view is opened until the label verifies, the text goes there, the lead view comes back', async () => {
    const { sender, tui } = route()
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'delivered' })
    expect(tui.submitted).toEqual([{ to: ECHO, text: TEXT }])
    // ↓ into the list, ↓ to delta, Enter (delta's view: no), ↓ to echo, Enter (verified), type,
    // ↓ from the empty input to main, Enter (the lead's view), ↑ (the input gets the focus back).
    expect(tui.keys()).toEqual([
      'down',
      'down',
      'enter',
      'down',
      'enter',
      'type',
      'down',
      'enter',
      'up'
    ])
    atLeadInput(tui)
  })

  it('[ADR-012] a row still labelled with the description is opened first', async () => {
    const { sender, tui } = route({ description: FOXTROT })
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'delivered' })
    expect(tui.submitted).toEqual([{ to: FOXTROT, text: TEXT }])
    expect(tui.keys().slice(0, 6)).toEqual(['down', 'down', 'down', 'down', 'enter', 'type'])
    atLeadInput(tui)
  })

  it('[ADR-012] the screen is read before every key and before the typing', async () => {
    const { sender, tui } = route()
    await sender.send(DWARF, TEXT)
    const steps = tui.events.filter((event) => !('read' in event))
    expect(steps.length).toBeGreaterThan(0)
    tui.events.forEach((event, index) => {
      if (!('read' in event)) expect(tui.events[index - 1]).toEqual({ read: true })
    })
  })

  it('[ADR-012] a row that leaves the list between the keys (its agent ended) never takes the text', async () => {
    const console_ = new FakeClaudeLeadConsole()
    let presses = 0
    console_.afterStep = (c) => {
      presses += 1
      // Right after ↓ reaches delta, delta ends: the pointer moves onto echo's row.
      if (presses === 2) c.finish('Run ping five times (delta)')
    }
    const { sender } = route({ description: 'Run ping five times (delta)' }, console_)
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'refused', reason: 'not-found' })
    expect(console_.submitted).toEqual([])
    atLeadInput(console_)
  })
})

describe('ClaudeSubagentConsoleSend: every doubt refuses before anything is typed', () => {
  it("[ADR-012] a person's draft in the lead input: refused with no key pressed, the draft untouched", async () => {
    const console_ = new FakeClaudeLeadConsole()
    console_.input = 'DRAFT-LEAD-TEXT'
    const { sender } = route({}, console_)
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'refused', reason: 'draft' })
    expect(console_.keys()).toEqual([])
    expect(console_.input).toBe('DRAFT-LEAD-TEXT')
  })

  it('[ADR-012] a draft typed meanwhile shows in the verified view: refused, nothing typed, back to main with the draft kept', async () => {
    const console_ = new FakeClaudeLeadConsole()
    let presses = 0
    console_.afterStep = (c) => {
      presses += 1
      if (presses === 4) c.input = 'DRAFT2-LEAD'
    }
    const { sender } = route({}, console_)
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'refused', reason: 'draft' })
    expect(console_.submitted).toEqual([])
    expect(console_.keys()).not.toContain('type')
    expect(console_.input).toBe('DRAFT2-LEAD')
    expect(console_.view).toBe(0)
  })

  it('[ADR-012] no description, or the same description on another live subagent: refused with nothing read', async () => {
    for (const facts of [{ description: null }, { twins: 1 }]) {
      const { sender, tui } = route(facts)
      expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'refused', reason: 'ambiguous' })
      expect(tui.events).toEqual([])
    }
  })

  it('[ADR-012] a Claude Code version whose layout the route does not know: refused with nothing read', async () => {
    expect(RECOGNISED_CLAUDE_VERSIONS).toEqual(['2.1.310'])
    for (const version of ['2.1.311', '2.1.309', null]) {
      const { sender, tui } = route({ version })
      expect(await sender.send(DWARF, TEXT)).toEqual({
        kind: 'refused',
        reason: 'unsupported-version'
      })
      expect(tui.events).toEqual([])
    }
  })

  it('[ADR-012] no view shows the description: every row tried, nothing typed, the lead view restored', async () => {
    const { sender, tui } = route({ description: 'Review the change' })
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'refused', reason: 'not-found' })
    expect(tui.submitted).toEqual([])
    expect(tui.keys()).not.toContain('type')
    atLeadInput(tui)
  })

  it('[ADR-012] a screen that is not the measured layout: refused before any key', async () => {
    const console_ = new FakeClaudeLeadConsole()
    console_.view = 1
    const { sender } = route({}, console_)
    expect(await sender.send(DWARF, TEXT)).toEqual({
      kind: 'refused',
      reason: 'unrecognised-screen'
    })
    expect(console_.keys()).toEqual([])
  })

  it('[ADR-012, ADR-014] a lead that is gone, a console that cannot be attached, no target: nothing written', async () => {
    const gone = route()
    gone.tui.readAnswers.push({ kind: 'gone' })
    expect(await gone.sender.send(DWARF, TEXT)).toEqual({ kind: 'gone' })
    const refused = route()
    refused.tui.readAnswers.push({ kind: 'not-targeted' })
    expect(await refused.sender.send(DWARF, TEXT)).toEqual({ kind: 'not-targeted' })
    const unknown = route(null)
    expect(await unknown.sender.send(DWARF, TEXT)).toEqual({ kind: 'not-targeted' })
    expect(unknown.asked).toEqual([DWARF])
    const blank = route()
    expect(await blank.sender.send(DWARF, ' \r\n ')).toEqual({ kind: 'not-targeted' })
    for (const world of [gone, refused, unknown, blank]) expect(world.tui.keys()).toEqual([])
  })

  it('[ADR-012] a read or a key that fails mid-way stops the route: incomplete, no further key', async () => {
    const reads = route()
    reads.tui.readAnswers.push(...[])
    const { sender, tui } = reads
    let presses = 0
    tui.afterStep = (c) => {
      presses += 1
      if (presses === 2) c.readAnswers.push({ kind: 'failed' })
    }
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'incomplete' })
    expect(tui.keys()).toEqual(['down', 'down'])
    const keys = route()
    keys.tui.keyAnswers.push('incomplete')
    expect(await keys.sender.send(DWARF, TEXT)).toEqual({ kind: 'incomplete' })
    expect(keys.tui.submitted).toEqual([])
  })

  it('[ADR-012] a typing that did not complete is incomplete, never delivered', async () => {
    const { sender, tui } = route()
    tui.writeAnswer = 'incomplete'
    expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'incomplete' })
    expect(tui.submitted).toEqual([])
  })
})

describe('ClaudeSubagentConsoleSend: Windows only, and never Esc', () => {
  it('[ADR-012] only a Windows Host reaches a subagent; elsewhere nothing is read or pressed', async () => {
    expect(route().sender.reaches()).toBe(true)
    for (const platform of ['darwin', 'linux'] as const) {
      const { sender, tui } = route({}, new FakeClaudeLeadConsole(), platform)
      expect(sender.reaches()).toBe(false)
      expect(await sender.send(DWARF, TEXT)).toEqual({ kind: 'not-targeted' })
      expect(tui.events).toEqual([])
    }
  })

  it('[ADR-012] over every scenario the route presses only ↓, ↑ and Enter, and ↑ never while the input has the focus', async () => {
    const worlds: FakeClaudeLeadConsole[] = []
    for (const description of [ECHO, FOXTROT, 'Run ping five times (delta)', 'Review the change']) {
      const console_ = new FakeClaudeLeadConsole()
      const upsFromInput: string[] = []
      const press = console_.press.bind(console_)
      console_.press = (target, key) => {
        if (key === 'up' && console_.focus === 'input') upsFromInput.push(description)
        return press(target, key)
      }
      await route({ description }, console_).sender.send(DWARF, TEXT)
      expect(upsFromInput).toEqual([])
      worlds.push(console_)
    }
    for (const console_ of worlds) {
      for (const key of console_.keys()) expect(['down', 'up', 'enter', 'type']).toContain(key)
    }
  })
})
