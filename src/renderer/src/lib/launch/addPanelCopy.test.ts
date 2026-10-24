import { describe, expect, it } from 'vitest'
import { addPanelSelects, addPanelWhy, permissionModeLabel, supplierLabel } from './addPanelCopy'
import { OTHER_CHOICE } from './launchState'

/*
 * The redesigned Add panel's words (#635), `organisms/add-panel` in the design: the line beside
 * Send the dwarf in, the three selects of the tuning row, and the supplier chips' names. The panel
 * draws; this decides, from the launch model's own reading.
 */
describe('addPanelWhy', () => {
  const base = {
    phase: 'provider-selection' as const,
    enabled: false,
    prompt: '',
    refusal: null,
    error: null,
    mineName: 'DwarfAI-Miners',
    jevAsking: false
  }

  it('asks for a supplier first, then for a prompt, then says where the dwarf walks in', () => {
    expect(addPanelWhy(base)).toEqual({
      text: 'Choose a supplier, or let Jev choose.',
      tone: 'status'
    })
    expect(addPanelWhy({ ...base, phase: 'known-provider-ready', enabled: true }).text).toBe(
      'Tell the dwarf what to work on.'
    )
    expect(
      addPanelWhy({ ...base, phase: 'prompt-ready', enabled: true, prompt: 'Dig.' }).text
    ).toBe('Ready. The dwarf walks into DwarfAI-Miners.')
  })

  it('reads a prompt of pure whitespace as no prompt', () => {
    expect(
      addPanelWhy({ ...base, phase: 'known-provider-ready', enabled: true, prompt: '  ' }).text
    ).toBe('Tell the dwarf what to work on.')
  })

  it('says the dwarf is being sent in while the launch is in flight, and while Jev is asked', () => {
    expect(addPanelWhy({ ...base, phase: 'submitted-spawning', enabled: true }).text).toBe(
      'Sending the dwarf in…'
    )
    expect(addPanelWhy({ ...base, enabled: true, prompt: 'Dig.', jevAsking: true }).text).toBe(
      'Sending the dwarf in…'
    )
  })

  it('puts a refused launch first, as an alert, and a chip that cannot start before the rest', () => {
    expect(addPanelWhy({ ...base, error: 'Claude Code is not installed.' })).toEqual({
      text: 'Claude Code is not installed.',
      tone: 'alert'
    })
    expect(addPanelWhy({ ...base, refusal: 'That provider is no longer detected.' }).text).toBe(
      'That provider is no longer detected.'
    )
  })

  it('keeps the detached launch’s own promise while its dwarf is proved', () => {
    expect(addPanelWhy({ ...base, phase: 'started-detached', enabled: true }).text).toBe(
      'The session started. Its dwarf joins the mine on the next sweep, and this panel opens on it once its transcript proves which one it is.'
    )
  })
})

describe('addPanelSelects', () => {
  const picker = {
    visible: true,
    models: [{ value: 'opus' }, { value: 'sonnet' }],
    disabled: false,
    note: null
  }
  const efforts = { visible: true, efforts: ['low', 'high'] }

  it('says Choose a supplier on all three, disabled, before one is chosen', () => {
    const row = addPanelSelects({
      choice: null,
      jevOn: false,
      modelPicker: { visible: false, models: [], disabled: true, note: null },
      effortPicker: { visible: false, efforts: [] },
      offeredModes: []
    })
    expect(row.map((select) => [select.label, select.disabled, select.options])).toEqual([
      ['Model', true, [{ value: '', label: 'Model: Choose a supplier' }]],
      ['Effort', true, [{ value: '', label: 'Effort: Choose a supplier' }]],
      ['Permissions', true, [{ value: '', label: 'Permissions: Choose a supplier' }]]
    ])
  })

  it('says Jev decides while Jev is on, and Custom for a command of the person’s own', () => {
    const hidden = { visible: false, models: [], disabled: true, note: null }
    const jev = addPanelSelects({
      choice: null,
      jevOn: true,
      modelPicker: hidden,
      effortPicker: { visible: false, efforts: [] },
      offeredModes: []
    })
    expect(jev.map((select) => select.options[0]!.label)).toEqual([
      'Model: Jev decides',
      'Effort: Jev decides',
      'Permissions: Jev decides'
    ])
    const custom = addPanelSelects({
      choice: OTHER_CHOICE,
      jevOn: false,
      modelPicker: hidden,
      effortPicker: { visible: false, efforts: [] },
      offeredModes: []
    })
    expect(custom.map((select) => [select.options[0]!.label, select.disabled])).toEqual([
      ['Model: Custom', true],
      ['Effort: Custom', true],
      ['Permissions: Custom', true]
    ])
  })

  it('lists the supplier’s own values, each prefixed with the select’s name', () => {
    const [model, effort, permissions] = addPanelSelects({
      choice: 'claude',
      jevOn: false,
      modelPicker: picker,
      effortPicker: efforts,
      offeredModes: ['ask-first']
    })
    expect(model!.options).toEqual([
      { value: 'opus', label: 'Model: opus' },
      { value: 'sonnet', label: 'Model: sonnet' }
    ])
    expect(model!.disabled).toBe(false)
    expect(effort!.options.map((option) => option.label)).toEqual(['Effort: low', 'Effort: high'])
    // AMENDED for ISSUE-228 (was: `{ value: 'default', … }`, held Claude's SDK mode): the select lists the entry's
    // offered mode ids (14 §3.6 `offeredModes`; ADR-011 item 1), the one v1 ships being `ask-first`.
    expect(permissions!.options).toEqual([{ value: 'ask-first', label: 'Permissions: Ask first' }])
  })

  it('draws a select the supplier has no values for disabled, on the session’s own default', () => {
    const [, effort, permissions] = addPanelSelects({
      choice: 'codex',
      jevOn: false,
      modelPicker: picker,
      effortPicker: { visible: false, efforts: [] },
      offeredModes: []
    })
    expect([effort!.disabled, effort!.options[0]!.label]).toEqual([true, 'Effort: Default'])
    expect([permissions!.disabled, permissions!.options[0]!.label]).toEqual([
      true,
      'Permissions: Default'
    ])
  })

  /*
   * APPENDED for #635 (MESSAGE-QUESTIONS 2; decision log, Jev's pick fills the pickers): each
   * select shows the value the launch model holds, so Jev's pick reads "Effort: high" rather than
   * the list's first entry while "high" is what would launch; nothing held, the first.
   */
  it('shows the value the launch model holds on each select, or the first with none held', () => {
    const base = {
      choice: 'claude' as const,
      jevOn: true,
      modelPicker: picker,
      effortPicker: efforts,
      offeredModes: ['ask-first']
    }
    const held = addPanelSelects({
      ...base,
      // AMENDED for ISSUE-228 (was: `'plan'`, a held Claude mode no entry offers): the held mode is an offered id.
      values: { model: 'sonnet', effort: 'high', permissionMode: 'ask-first' }
    })
    expect(held.map((select) => select.value)).toEqual(['sonnet', 'high', 'ask-first'])

    const none = addPanelSelects({
      ...base,
      values: { model: null, effort: null, permissionMode: null }
    })
    expect(none.map((select) => select.value)).toEqual([undefined, undefined, undefined])
  })
})

describe('the supplier and permission names', () => {
  it('names a supplier as people know it, and the custom command as Other…', () => {
    expect(supplierLabel('claude')).toBe('Claude')
    expect(supplierLabel('opencode')).toBe('OpenCode')
    expect(supplierLabel(OTHER_CHOICE)).toBe('Other…')
  })

  // AMENDED for ISSUE-228 (was: held Claude's `default`, `acceptEdits` and `plan` as "Ask first", "Accept edits",
  // "Plan only"): the select names the Host's mode ids. v1 ships one mode, "Ask first" (owner, 2026-10-24); an id the
  // design has no word for keeps its own id, never an invented one (25-AGENTS §8.1).
  it('[US-LAUNCH-001.AC13, ADR-011] names Ask first in the design’s words, and any other mode id as the id itself', () => {
    expect(permissionModeLabel('ask-first')).toBe('Ask first')
    expect(permissionModeLabel('plan-only')).toBe('plan-only')
  })
})

/*
 * #635 (MESSAGE-QUESTIONS 14/16/17): with the launch-failure notice naming the cause, the line
 * beside Send the dwarf in only says that the dwarf did not go in (copy.md, Add a dwarf).
 */
describe('addPanelWhy after a launch the notice names a cause for', () => {
  const failed = {
    phase: 'prompt-ready' as const,
    enabled: true,
    prompt: 'Dig.',
    refusal: null,
    error: null,
    mineName: 'DwarfAI-Miners',
    jevAsking: false,
    failed: true
  }

  it('says the dwarf did not go in, as the panel standing, not a second alert', () => {
    expect(addPanelWhy(failed)).toEqual({ text: 'The dwarf did not go in.', tone: 'status' })
  })

  it('gives way to the next launch in flight', () => {
    expect(addPanelWhy({ ...failed, phase: 'submitted-spawning' }).text).toBe(
      'Sending the dwarf in…'
    )
  })
})

/*
 * #635 (PO decision 2026-09-28) gave Codex its own three modes; AMENDED for ISSUE-228 (owner, 2026-10-24): the select
 * lists the modes the chosen supplier's entry offers (14 §3.6 `offeredModes`; ADR-011 item 1), the same for every
 * supplier. Every launch is the Host's since 4b, and the Host refuses a mode its entry does not offer, so Codex's
 * `workspace-write`/`read-only` and held Claude's five SDK modes could no longer launch.
 */
describe('the Permissions select from the entry’s offered modes (ISSUE-228)', () => {
  const codex = {
    choice: 'codex' as const,
    jevOn: false,
    modelPicker: { visible: true, models: [{ value: 'gpt-5-codex' }], disabled: false, note: null },
    effortPicker: { visible: true, efforts: ['low', 'medium', 'high'] },
    offeredModes: ['ask-first']
  }

  // AMENDED for ISSUE-228 (was: "lists Codex's three modes in the design's words, enabled, Codex default first").
  it('[US-LAUNCH-001.AC04, US-LAUNCH-001.AC13] lists Ask first for a supplier that offers it, enabled, its first shown with none held', () => {
    const [, , permissions] = addPanelSelects(codex)
    expect(permissions!.disabled).toBe(false)
    expect(permissions!.options).toEqual([{ value: 'ask-first', label: 'Permissions: Ask first' }])
    expect(permissions!.value).toBeUndefined()
  })

  // AMENDED for ISSUE-228 (was: the held `read-only` of Codex's own list).
  it('[US-LAUNCH-001.AC06] shows the offered mode the launch model holds', () => {
    const [, , permissions] = addPanelSelects({
      ...codex,
      offeredModes: ['ask-first', 'plan-only'],
      values: { model: null, effort: null, permissionMode: 'plan-only' }
    })
    expect(permissions!.options.map((option) => option.value)).toEqual(['ask-first', 'plan-only'])
    expect(permissions!.value).toBe('plan-only')
  })

  // AMENDED for ISSUE-228 (was: "keeps held Claude's own five modes unchanged").
  it('[US-LAUNCH-001.AC07] lists only the chosen supplier’s offered modes, never another vocabulary', () => {
    const [, , permissions] = addPanelSelects({ ...codex, choice: 'claude' })
    expect(permissions!.options.map((option) => option.value)).toEqual(['ask-first'])
  })
})
