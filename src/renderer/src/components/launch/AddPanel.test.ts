// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPOSER_ENABLED_PLACEHOLDER,
  OTHER_CHOICE,
  type LaunchPhase
} from '../../lib/launch/launchState'
import type { JevState } from '../../lib/launch/launchState'
import {
  MODEL_HISTORY_SOURCE,
  NO_MODEL_LIST,
  type EffortPicker,
  type ModelPicker
} from '../../lib/launch/modelTuning'
import { providerChips } from '../../lib/launch/providerChips'
import type { AgentProviderOption } from '../../types'
import AddPanel from './AddPanel.vue'

const HIDDEN_MODEL_PICKER: ModelPicker = { visible: false, models: [], disabled: true, note: null }
const HIDDEN_EFFORT_PICKER: EffortPicker = { visible: false, efforts: [] }
const HIDDEN_JEV: JevState = {
  availability: 'hidden',
  enabled: false,
  // AMENDED for #523: the two fields the state grew. Defaults off, as the
  // state machine itself starts them; tests that want them on say so.
  autoAccept: false,
  routing: { phase: 'idle' },
  previousChoice: null,
  launchedOnFallback: false
}

const CLAUDE: AgentProviderOption = { provider: 'claude', installed: true, launchable: true }
const CODEX: AgentProviderOption = {
  provider: 'codex',
  installed: true,
  launchable: false,
  reason: 'Only Claude can be started from the panel today.'
}

/*
 * AMENDED for #635: the redesigned panel (organisms/add-panel) names its mine, and draws the
 * design's own placeholder on the prompt in every state, so the launch model's composer
 * placeholder is no longer one of its props; `placeholder` overrides are accepted and ignored so
 * the cases that set it read as they did.
 */
function panel(overrides: Partial<Record<string, unknown>> = {}) {
  const chosen = (overrides.chosen ?? null) as 'claude' | 'codex' | typeof OTHER_CHOICE | null
  return mount(AddPanel, {
    props: {
      mineName: 'DwarfAI-Miners',
      chips: providerChips([CLAUDE, CODEX], chosen),
      phase: (overrides.phase ?? 'provider-selection') as LaunchPhase,
      enabled: (overrides.enabled ?? false) as boolean,
      command: (overrides.command ?? '') as string,
      prompt: (overrides.prompt ?? '') as string,
      refusal: (overrides.refusal ?? null) as string | null,
      error: (overrides.error ?? null) as string | null,
      modelPicker: (overrides.modelPicker ?? HIDDEN_MODEL_PICKER) as ModelPicker,
      effortPicker: (overrides.effortPicker ?? HIDDEN_EFFORT_PICKER) as EffortPicker,
      permissionsVisible: (overrides.permissionsVisible ?? false) as boolean,
      jev: (overrides.jev ?? HIDDEN_JEV) as JevState,
      // APPENDED for #635: `onCommit`-style listeners, for the cases that read the ORDER in which
      // the panel reports two gestures, which `emitted()` keeps per event and cannot show.
      ...((overrides.listeners ?? {}) as Record<string, unknown>)
    },
    ...(overrides.attachTo === undefined ? {} : { attachTo: overrides.attachTo as HTMLElement })
  })
}

/*
 * AMENDED for #635 throughout this file: the redesigned panel draws the design's parts —
 * ChoiceChip radios in a radiogroup, the InputField prompt and command, SelectField selects, the
 * ToggleSwitch pair and Send the dwarf in — so the selectors and the words are the design's, and
 * each case that changed meaning says what it pinned before.
 */
const CHIPS = '.dm-add__chips .dm-chip'
const PROMPT = '.dm-add__prompt textarea'
const COMMAND = '.dm-add__command input'
const LAUNCH = '.dm-add__launch'
const WHY = '.dm-add__why'
const CLOSE = '.dm-add__close'
const JEV_TOGGLE = 'button[aria-label="Let Jev choose"]'
const JEV_AUTO = 'button[aria-label="Auto-accept Jev"]'

describe('the chip row', () => {
  // AMENDED for #635 (was: ['claude', 'codex', 'Other']): the tools' own names, and Other….
  it('draws one chip per detected provider, with Other last', () => {
    const chips = panel().findAll(CHIPS)

    expect(chips.map((chip) => chip.text())).toEqual(['Claude', 'Codex', 'Other…'])
  })

  // AMENDED for #635 (was: each chip's data-state, for the old sheet's three treatments). The
  // design's chip is a radio, so the one state it draws is checked or not.
  it('publishes each chip’s state, so the design’s checked treatment is drawable', () => {
    const chips = panel({ chosen: 'claude' }).findAll(CHIPS)

    expect(chips.map((chip) => chip.attributes('aria-checked'))).toEqual(['true', 'false', 'false'])
  })

  it('asks for the chip that was clicked and decides nothing itself', async () => {
    const wrapper = panel()

    await wrapper.findAll(CHIPS)[1]?.trigger('click')

    expect(wrapper.emitted('choose')).toEqual([['codex']])
  })

  // AMENDED for #635 (was: aria-pressed): a radio in a radiogroup says it with aria-checked.
  it('says which chip is pressed for anything not looking at it', () => {
    const wrapper = panel({ chosen: OTHER_CHOICE })
    const chips = wrapper.findAll(CHIPS)

    expect(wrapper.get('.dm-add__chips').attributes('role')).toBe('radiogroup')
    expect(chips.map((chip) => chip.attributes('role'))).toEqual(['radio', 'radio', 'radio'])
    expect(chips.map((chip) => chip.attributes('aria-checked'))).toEqual(['false', 'false', 'true'])
  })
})

describe('the composer gate', () => {
  // AMENDED for #635 (was: 'is disabled with the source’s instruction before a choice', the
  // composer disabled under "Select your Dwarf supplier"). The design's prompt is writable in
  // every state; the gate is Send the dwarf in, and the line beside it says what it waits for.
  it('lets the prompt be written before a choice, and holds Send the dwarf in until one', () => {
    const wrapper = panel()
    const prompt = wrapper.get(PROMPT)

    expect(prompt.attributes('disabled')).toBeUndefined()
    expect(prompt.attributes('placeholder')).toBe('What should this dwarf work on?')
    expect(wrapper.get(LAUNCH).attributes('disabled')).toBeDefined()
    expect(wrapper.get(WHY).text()).toBe('Choose a supplier, or let Jev choose.')
  })

  // AMENDED for #635 (was: the composer enabled under "Write here..."): once the gate opens, the
  // line asks for the prompt, and Send the dwarf in wakes with one.
  it('asks for a prompt once the gate opens, and wakes Send the dwarf in with one', () => {
    const open = panel({ chosen: 'claude', phase: 'known-provider-ready', enabled: true })

    expect(open.get(WHY).text()).toBe('Tell the dwarf what to work on.')
    expect(open.get(LAUNCH).attributes('disabled')).toBeDefined()

    const ready = panel({ chosen: 'claude', phase: 'prompt-ready', enabled: true, prompt: 'dig' })
    expect(ready.get(WHY).text()).toBe('Ready. The dwarf walks into DwarfAI-Miners.')
    expect(ready.get(LAUNCH).attributes('disabled')).toBeUndefined()
  })

  // AMENDED for #431 (was: 'caps the prompt at the same length a delivered
  // message is capped at', asserting a maxlength of MAX_DWARF_TEXT_CHARS). That
  // ceiling is the command line a MESSAGE's channel is spawned with; a launch
  // prompt goes down the child's stdin or straight onto a held stream and has
  // no command line to fit inside, so the attribute was cutting a paste for a
  // bound that does not exist. It asserts the absence now, which is the
  // behaviour — see prepareLaunchPrompt, which lost the matching slice.
  it('lets the box hold whatever was pasted: a launch prompt has no ceiling', () => {
    expect(panel().get(PROMPT).attributes('maxlength')).toBeUndefined()
  })
})

describe('the custom-command input', () => {
  // AMENDED for #635 (was: not rendered until Other is chosen): the design keeps the field in
  // the tree and hides it, so it is hidden, not absent, until Other… opens it.
  it('is hidden until Other is chosen', () => {
    const field = panel({ chosen: 'claude', phase: 'known-provider-ready' }).get('.dm-add__command')

    expect(field.attributes('hidden')).toBeDefined()
  })

  // AMENDED for #635 (was: COMMAND_PLACEHOLDER, "Say your command..."): the design's own words.
  it('appears with the design’s own placeholder when Other is chosen', () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })

    expect(wrapper.get('.dm-add__command').attributes('hidden')).toBeUndefined()
    expect(wrapper.get(COMMAND).attributes('placeholder')).toBe(
      'Custom command, e.g. my-agent --yes'
    )
  })

  it('commits on Enter and reports what was typed', async () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })
    const command = wrapper.get(COMMAND)

    await command.setValue('lalolanda')
    await command.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('command')?.at(-1)).toEqual(['lalolanda'])
    expect(wrapper.emitted('commit')).toHaveLength(1)
  })
})

/*
 * The row under the composer (#239, launch.md's maintainer amendment): model,
 * effort and permissions, visible only once a real provider chip is chosen.
 */
describe('the model, effort and permission row', () => {
  const LIVE_MODEL_PICKER: ModelPicker = {
    visible: true,
    models: [
      { value: 'claude-sonnet-5', label: 'Sonnet' },
      { value: 'claude-haiku-4-5', label: 'Haiku' }
    ],
    disabled: false,
    note: null
  }

  const optionTexts = (wrapper: ReturnType<typeof panel>, label: string) =>
    wrapper
      .get(`select[aria-label="${label}"]`)
      .findAll('option')
      .map((option) => option.text())

  // AMENDED for #635 (was: 'is absent before a real provider chip is chosen'). The design draws
  // the row in every state, disabled with "Choose a supplier" until one is picked.
  it('is drawn disabled, saying Choose a supplier, before a real provider chip is chosen', () => {
    const wrapper = panel()

    for (const label of ['Model', 'Effort', 'Permissions']) {
      expect(wrapper.get(`select[aria-label="${label}"]`).attributes('disabled')).toBeDefined()
      expect(optionTexts(wrapper, label)).toEqual([label + ': Choose a supplier'])
    }
  })

  // AMENDED for #635 (was: 'is absent for Other, which has no provider identity for it'). Other…
  // still has no lists; the design says so on the row, "Custom", disabled.
  it('is drawn disabled, saying Custom, for Other, which has no provider identity for it', () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })

    for (const label of ['Model', 'Effort', 'Permissions']) {
      expect(wrapper.get(`select[aria-label="${label}"]`).attributes('disabled')).toBeDefined()
      expect(optionTexts(wrapper, label)).toEqual([label + ': Custom'])
    }
  })

  /*
   * APPENDED for #635: while Jev is on and no chip is chosen, the row says Jev decides, since
   * the selects will show its choice once it answers (screens/launch.md, As built).
   */
  it('says Jev decides on the row while Jev is on and no chip is chosen', () => {
    const wrapper = panel({
      jev: { ...HIDDEN_JEV, availability: 'ready', enabled: true }
    })

    expect(optionTexts(wrapper, 'Model')).toEqual(['Model: Jev decides'])
  })

  // AMENDED for #635 (was: ['Sonnet', 'Haiku']): each option carries the select's name.
  it('draws one option per model the picker offers, labelled where it has one', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      modelPicker: LIVE_MODEL_PICKER
    })

    expect(optionTexts(wrapper, 'Model')).toEqual(['Model: Sonnet', 'Model: Haiku'])
  })

  it('disables the model select with the picker’s own reason for a provider main could not ask', () => {
    const wrapper = panel({
      chosen: 'antigravity',
      phase: 'known-provider-ready',
      modelPicker: { visible: true, models: [], disabled: true, note: NO_MODEL_LIST }
    })

    expect(wrapper.get('select[aria-label="Model"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.dm-add__note').text()).toBe(NO_MODEL_LIST)
  })

  it('shows the source note for a history-derived list, without disabling it', () => {
    const wrapper = panel({
      chosen: 'codex',
      phase: 'known-provider-ready',
      modelPicker: {
        visible: true,
        models: [{ value: 'gpt-5.6-sol' }],
        disabled: false,
        note: MODEL_HISTORY_SOURCE
      }
    })

    expect(wrapper.get('select[aria-label="Model"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('.dm-add__note').text()).toBe(MODEL_HISTORY_SOURCE)
  })

  it('reports the model chosen off the select', async () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      modelPicker: LIVE_MODEL_PICKER
    })

    await wrapper.get('select[aria-label="Model"]').setValue('claude-haiku-4-5')

    expect(wrapper.emitted('model')).toEqual([['claude-haiku-4-5']])
  })

  // AMENDED for #635 (was: 'draws no effort select for a provider the picker says has none').
  // The row keeps its three parts: a select with no values stays drawn, disabled, on the default.
  // The row reads the checked chip, and this fixture's chips are Claude and Codex, so the case
  // chooses Codex where it chose Antigravity, which has no chip here.
  it('draws the effort select disabled, on the default, for a provider the picker says has none', () => {
    const wrapper = panel({
      chosen: 'codex',
      phase: 'known-provider-ready',
      modelPicker: { visible: true, models: [], disabled: true, note: NO_MODEL_LIST },
      effortPicker: { visible: false, efforts: [] }
    })

    expect(wrapper.get('select[aria-label="Effort"]').attributes('disabled')).toBeDefined()
    expect(optionTexts(wrapper, 'Effort')).toEqual(['Effort: Default'])
  })

  it('draws one option per effort level, and reports the one chosen', async () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      modelPicker: LIVE_MODEL_PICKER,
      effortPicker: { visible: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
    })
    const select = wrapper.get('select[aria-label="Effort"]')

    // AMENDED for #635: each option carries the select's name.
    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'Effort: low',
      'Effort: medium',
      'Effort: high',
      'Effort: xhigh',
      'Effort: max'
    ])

    await select.setValue('xhigh')
    expect(wrapper.emitted('effort')).toEqual([['xhigh']])
  })

  // AMENDED for #635 (was: 'draws no permissions select outside a held Claude session'): drawn,
  // disabled, on the session's own default, so the row keeps its three parts.
  it('draws the permissions select disabled, on the default, outside a held Claude session', () => {
    const wrapper = panel({
      chosen: 'codex',
      phase: 'known-provider-ready',
      modelPicker: {
        visible: true,
        models: [{ value: 'gpt-5.6-sol' }],
        disabled: false,
        note: null
      },
      permissionsVisible: false
    })

    expect(wrapper.get('select[aria-label="Permissions"]').attributes('disabled')).toBeDefined()
    expect(optionTexts(wrapper, 'Permissions')).toEqual(['Permissions: Default'])
  })

  it('draws every non-bypass permission mode for a held Claude session, and reports the one chosen', async () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      modelPicker: LIVE_MODEL_PICKER,
      permissionsVisible: true
    })
    const select = wrapper.get('select[aria-label="Permissions"]')

    // AMENDED for #635 (was: the SDK's raw mode names): the design's words where it has them.
    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'Permissions: Ask first',
      'Permissions: Accept edits',
      'Permissions: Plan only',
      "Permissions: Don't ask",
      'Permissions: Auto'
    ])
    expect(select.findAll('option').map((option) => option.attributes('value'))).not.toContain(
      'bypassPermissions'
    )

    await select.setValue('plan')
    expect(wrapper.emitted('permissionMode')).toEqual([['plan']])
  })

  // AMENDED for #635 (was: 'is absent once the session has launched'). The design keeps the
  // panel as it is while the dwarf is sent in; nothing on the row can be changed any more.
  it('cannot be changed once the session has launched, alongside the chips and the prompt', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'submitted-spawning',
      enabled: true,
      prompt: 'dig the east gallery',
      modelPicker: LIVE_MODEL_PICKER
    })

    for (const label of ['Model', 'Effort', 'Permissions']) {
      expect(wrapper.get(`select[aria-label="${label}"]`).attributes('disabled')).toBeDefined()
    }
  })
})

describe('sending the first prompt', () => {
  function ready(overrides: Record<string, unknown> = {}) {
    return panel({
      chosen: 'claude',
      phase: 'prompt-ready',
      enabled: true,
      placeholder: COMPOSER_ENABLED_PLACEHOLDER,
      prompt: 'dig here',
      ...overrides
    })
  }

  // AMENDED for #635 (was: 'submits on Enter'). The design's prompt is a four-row field that
  // takes line breaks; Ctrl+Enter (Cmd+Enter on a Mac) launches, as does Send the dwarf in.
  it('submits on Ctrl+Enter or Cmd+Enter, and on Send the dwarf in', async () => {
    const wrapper = ready()

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', metaKey: true })
    await wrapper.get(LAUNCH).trigger('click')

    expect(wrapper.emitted('submit')).toHaveLength(3)
  })

  // AMENDED for #635 (was: 'writes a newline on Shift+Enter instead of submitting'): every plain
  // Enter is a line break now, Shift or not.
  it('writes a newline on a plain Enter, or Shift+Enter, instead of submitting', async () => {
    const wrapper = ready()

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter' })
    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('does not submit from a composer the gate has not opened', async () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required', prompt: 'dig' })

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await wrapper.get(LAUNCH).trigger('click')

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  // APPENDED for #635: a prompt of pure whitespace is no prompt, as main reads it.
  it('does not submit a prompt of pure whitespace', async () => {
    const wrapper = ready({ prompt: '   ' })

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })

    expect(wrapper.get(LAUNCH).attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})

describe('what the panel says out loud', () => {
  // AMENDED for #635 (was: `.launch-note`): the line beside Send the dwarf in says it.
  it('states why the chosen chip cannot start a session', () => {
    const wrapper = panel({ chosen: 'codex', phase: 'known-provider-ready', refusal: CODEX.reason })

    expect(wrapper.get(WHY).text()).toBe(CODEX.reason)
  })

  it('carries a refused launch’s own reason, in its own alert', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'prompt-ready',
      enabled: true,
      error: 'Claude Code is not installed on this machine.'
    })

    // AMENDED for #635 (was: `.launch-alert`): the line beside Send the dwarf in, as an alert,
    // until the launch-failure notice per cause arrives (PR4 of #635).
    const why = wrapper.get(WHY)
    expect(why.text()).toBe('Claude Code is not installed on this machine.')
    expect(why.attributes('role')).toBe('alert')
    expect(why.classes()).toContain('is-alert')
  })

  /*
   * Issue #263. A detached launch that failed after it started drops main
   * back to the SAME shape a refused launch already renders in: `useAgentLaunch`
   * and `launchState.launchFailed` do the work of returning `phase` to
   * `prompt-ready` with `error` set, so this component needs no state of its
   * own for it — the alert already renders from `error` regardless of which
   * failure produced it. This pins that the composer is drawn alongside it,
   * not swallowed by the detached view it just left.
   */
  it('shows a launch that failed after it started in the same alert, with the composer back', () => {
    const wrapper = panel({
      chosen: 'codex',
      phase: 'prompt-ready',
      enabled: true,
      prompt: 'dig the east gallery',
      error: 'codex: another instance is already running'
    })

    // AMENDED for #635: the design's selectors.
    expect(wrapper.get(WHY).text()).toBe('codex: another instance is already running')
    expect(wrapper.get(WHY).attributes('role')).toBe('alert')
    const composer = wrapper.get(PROMPT)
    expect(composer.attributes('disabled')).toBeUndefined()
    expect((composer.element as HTMLTextAreaElement).value).toBe('dig the east gallery')
  })

  it('closes when its close control is used', async () => {
    const wrapper = panel()

    await wrapper.get(CLOSE).trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape, as every panel here does', async () => {
    const wrapper = panel()

    await wrapper.get('.dm-add').trigger('keydown.escape')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('while the session is starting', () => {
  function spawning() {
    return panel({
      chosen: 'claude',
      phase: 'submitted-spawning',
      enabled: true,
      prompt: 'dig the east gallery'
    })
  }

  /*
   * AMENDED for #635 (was: 'shows the submitted prompt where its first message belongs', the
   * spawning view's `.launch-first-message` bubble). The redesign has no spawning view: the panel
   * stays as it is while the dwarf is sent in (screens/launch.md, As built), so the prompt stays
   * on screen in its own field until the MessagePanel takes the slot and draws main's record of
   * it — still never shown twice.
   */
  it('keeps the submitted prompt on screen, in its own field, while the dwarf is sent in', () => {
    const prompt = spawning().get(PROMPT)

    expect((prompt.element as HTMLTextAreaElement).value).toBe('dig the east gallery')
  })

  // AMENDED for #635 (was: any `.launch-note` text): the design's own words.
  it('says a session is starting rather than looking like nothing happened', () => {
    expect(spawning().get(WHY).text()).toBe('Sending the dwarf in…')
  })

  // AMENDED for #635 (was: 'takes the chips and the composer away while one is in flight'). They
  // stay drawn, and nothing on them can be pressed or changed, Send the dwarf in included.
  it('lets nothing on the chips, the prompt or Send be pressed while one is in flight', () => {
    const wrapper = spawning()

    for (const chip of wrapper.findAll(CHIPS)) expect(chip.attributes('disabled')).toBeDefined()
    expect(wrapper.get(PROMPT).attributes('disabled')).toBeDefined()
    expect(wrapper.get(LAUNCH).attributes('disabled')).toBeDefined()
  })

  it('can still be closed, so a launch that never lands is not a trap', async () => {
    const wrapper = spawning()

    await wrapper.get(CLOSE).trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

/*
 * The end of a launch this panel cannot watch (#168).
 *
 * A detached launch — Codex's only shape, because it has no held-session engine
 * in this app — leaves no receipt for `launchedDwarfIn` to match, so no
 * MessagePanel hand-over is coming. The panel therefore has to say what it
 * actually knows and stop, rather than sitting in the spawning view watching
 * for an arrival it knows cannot happen.
 */
describe('after a session the panel cannot watch has started', () => {
  function detached() {
    return panel({
      chosen: 'codex',
      phase: 'started-detached',
      enabled: true,
      prompt: 'dig the east gallery'
    })
  }

  it('says the session started and where its dwarf will turn up', () => {
    // AMENDED for #635 (was: `.launch-note`): the line beside Send the dwarf in says it.
    const note = detached().get(WHY).text()

    expect(note).toBeTruthy()
    expect(note.toLowerCase()).toContain('mine')
  })

  it('never claims the panel is still looking for it', () => {
    // The spawning copy promises the panel will find it. That promise cannot be
    // kept for a detached launch, so this state must not borrow the wording.
    expect(detached().get(WHY).text().toLowerCase()).not.toContain('as soon as')
  })

  // AMENDED for #635 (was: the composer and the chips taken away). They stay drawn, and nothing
  // on them can be pressed, so the same prompt is still not sent twice.
  it('lets nothing be sent again, so the same prompt is not sent twice', async () => {
    const wrapper = detached()

    expect(wrapper.get(PROMPT).attributes('disabled')).toBeDefined()
    for (const chip of wrapper.findAll(CHIPS)) expect(chip.attributes('disabled')).toBeDefined()
    expect(wrapper.get(LAUNCH).attributes('disabled')).toBeDefined()
    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('can be closed, which is the only way out of it', async () => {
    const wrapper = detached()

    await wrapper.get(CLOSE).trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

/*
 * Jev (#509): the toggle beside the pickers, the decision it can apply
 * before a launch happens, and the line that says a launch happened anyway.
 * This component decides nothing about any of it — `jev` is main's verdict
 * and `launchState`'s own reading of it, already resolved by the time it
 * reaches here; this only draws what the prop says and reports gestures back.
 */
describe('the Jev option', () => {
  const READY_JEV: JevState = {
    availability: 'ready',
    enabled: false,
    // AMENDED for #523: the two fields the state grew, defaulted as the state
    // machine itself starts them. Tests that want them on say so.
    autoAccept: false,
    routing: { phase: 'idle' },
    previousChoice: null,
    launchedOnFallback: false
  }
  const ASKING_JEV: JevState = { ...READY_JEV, enabled: true, routing: { phase: 'asking' } }
  const DECISION: JevState['routing'] = {
    phase: 'decided',
    decision: {
      kind: 'decision',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      confidence: 0.87,
      truncated: false,
      // request v2 (jev-routing-profiles T3): JevRouteLaunchResult's decision
      // arm gained these two fields — mechanical fixture update, T4 owns
      // actually rendering them.
      tier: 'frontier',
      parts: {
        provider: { value: 'codex', confidence: 0.87, applied: 'answered' },
        tier: { value: 'frontier', confidence: 0.9, applied: 'answered' },
        trivial: { value: false, probability: 0.05 },
        largeContext: { value: false, probability: 0.05 },
        // #608: `parts` gained a `model` field — mechanical fixture update,
        // this suite (T4) does not yet render it; matches `model` above.
        model: { value: 'gpt-5.6-sol', applied: 'answered', probability: 0.82 }
      }
    }
  }

  /*
   * AMENDED for #635 (was: 'is absent with no key configured — #509’s own first option'). The
   * design draws Jev in every state of the panel, so with no key the switches are drawn off and
   * disabled, and say why on themselves, rather than being left out.
   */
  it('is drawn off and disabled with no key configured, saying no key is set', () => {
    const wrapper = panel({ jev: HIDDEN_JEV })

    for (const selector of [JEV_TOGGLE, JEV_AUTO]) {
      const toggle = wrapper.get(selector)
      expect(toggle.attributes('disabled')).toBeDefined()
      expect(toggle.attributes('aria-checked')).toBe('false')
      expect(toggle.attributes('title')).toBe('No TypeSafe key is set')
    }
  })

  // AMENDED for #635 (was: `.jev-toggle` disabled beside a `.jev-unavailable-reason` line): the
  // reason main gave is on the switch itself.
  it('is shown disabled, with the reason, for anything else that keeps it off', () => {
    const unavailable: JevState = {
      availability: 'unavailable',
      unavailableReason: 'encryption-unavailable',
      enabled: false,
      // AMENDED for #523: the two required fields, at their defaults.
      autoAccept: false,
      routing: { phase: 'idle' },
      previousChoice: null,
      launchedOnFallback: false
    }
    const wrapper = panel({ jev: unavailable })

    const toggle = wrapper.get(JEV_TOGGLE)
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(toggle.attributes('title')).toBe(
      'This machine offers no encrypted place to keep a key, so Jev cannot be turned on here.'
    )
  })

  // AMENDED for #635 (was: `.jev-toggle` with aria-pressed): the design's switch, aria-checked.
  it('is a pressable toggle once ready, reporting the press and nothing else', async () => {
    const wrapper = panel({ jev: READY_JEV })
    const toggle = wrapper.get(JEV_TOGGLE)

    expect(toggle.attributes('disabled')).toBeUndefined()
    expect(toggle.attributes('aria-checked')).toBe('false')

    await toggle.trigger('click')

    expect(wrapper.emitted('toggle-jev')).toHaveLength(1)
    expect(wrapper.emitted('toggle-jev-auto')).toBeUndefined()
  })

  it('shows the toggle pressed once the person has turned it on', () => {
    const wrapper = panel({ jev: { ...READY_JEV, enabled: true } })

    expect(wrapper.get(JEV_TOGGLE).attributes('aria-checked')).toBe('true')
  })

  // AMENDED for #635 (was: `.jev-status` reading "Asking Jev…"). Asking Jev is part of sending
  // the dwarf in, and the design says that one line for the whole flight.
  it('says it is asking while the ask is in flight', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      jev: ASKING_JEV
    })

    expect(wrapper.get(WHY).text()).toBe('Sending the dwarf in…')
  })

  // AMENDED for #635 (was: a plain Enter in `.launch-input`): the launching keys and the button.
  it('refuses a second Enter while Jev is being asked', async () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'prompt-ready',
      enabled: true,
      prompt: 'dig here',
      jev: ASKING_JEV
    })

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await wrapper.get(LAUNCH).trigger('click')

    expect(wrapper.get(LAUNCH).attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  describe('the decision card', () => {
    function withDecision(overrides: Record<string, unknown> = {}) {
      return panel({
        chosen: 'codex',
        phase: 'known-provider-ready',
        jev: { ...READY_JEV, enabled: true, routing: DECISION },
        ...overrides
      })
    }

    it('names the provider Jev chose off the same label source the chips use', () => {
      const wrapper = withDecision()

      expect(wrapper.get('.jev-decision-summary').text()).toContain('codex')
    })

    it('resolves the model label off the picker’s own catalogue, falling back to the raw id', () => {
      const wrapper = withDecision({
        modelPicker: {
          visible: true,
          models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
          disabled: false,
          note: null
        }
      })

      expect(wrapper.get('.jev-decision-summary').text()).toContain('GPT-5.6 Sol')
    })

    it('falls back to the raw model id when the catalogue names it no label', () => {
      const wrapper = withDecision({
        modelPicker: { visible: true, models: [], disabled: true, note: null }
      })

      expect(wrapper.get('.jev-decision-summary').text()).toContain('gpt-5.6-sol')
    })

    it('states the effort level and the confidence as a percentage', () => {
      const wrapper = withDecision()

      expect(wrapper.get('.jev-decision-summary').text()).toContain('high')
      expect(wrapper.get('.jev-decision-summary').text()).toContain('87%')
    })

    /*
     * #608 T3: `confidence` is now `undefined` (never `0`) when no part was
     * actually answered — the headline must show no percentage at all
     * rather than fall back to a number that never came from Jev.
     */
    it('shows no confidence figure at all when nothing was actually answered', () => {
      const wrapper = withDecision({
        jev: {
          ...READY_JEV,
          enabled: true,
          routing: {
            phase: 'decided',
            decision: { ...DECISION.decision, confidence: undefined }
          }
        }
      })

      expect(wrapper.get('.jev-decision-summary').text()).not.toMatch(/\d+%/)
    })

    it('notes a trimmed prompt only when the decision says it was truncated', () => {
      const trimmed = withDecision({
        jev: {
          ...READY_JEV,
          enabled: true,
          routing: { ...DECISION, decision: { ...DECISION.decision, truncated: true } }
        }
      })
      const untrimmed = withDecision()

      expect(trimmed.get('.jev-decision-truncated').text()).toBeTruthy()
      expect(untrimmed.find('.jev-decision-truncated').exists()).toBe(false)
    })

    it('says the pickers below now show the choice and can still be changed', () => {
      expect(withDecision().get('.jev-decision-note').text()).toBeTruthy()
    })

    /*
     * jev-routing-profiles T4. The card gains the tier in words and a
     * per-part line naming which parts Jev itself answered confidently —
     * `DECISION`'s own fixture above has both `provider` and `tier`
     * `applied: 'answered'`, tier `'frontier'`, confidences 87%/90%.
     */
    describe('the tier and per-part line (T4)', () => {
      it('shows the tier in words, and names both parts Jev chose with their own confidence', () => {
        const text = withDecision().get('.jev-decision-parts').text()

        expect(text).toContain('frontier')
        expect(text).toContain('90%')
        expect(text).toContain('codex')
        expect(text).toContain('87%')
      })

      it('names a part that fell to a safe value instead of Jev’s own answer', () => {
        const wrapper = withDecision({
          jev: {
            ...READY_JEV,
            enabled: true,
            routing: {
              phase: 'decided',
              decision: {
                ...DECISION.decision,
                parts: {
                  ...DECISION.decision.parts,
                  provider: { value: 'codex', confidence: 0.54, applied: 'safe-default' }
                }
              }
            }
          }
        })

        const text = wrapper.get('.jev-decision-parts').text()

        expect(text).toContain('unsure about the provider')
        expect(text).toContain('54%')
      })

      it('shows the trivial flag only when the local decision treated the prompt as trivial', () => {
        const trivial = withDecision({
          jev: {
            ...READY_JEV,
            enabled: true,
            routing: {
              phase: 'decided',
              decision: {
                ...DECISION.decision,
                parts: {
                  ...DECISION.decision.parts,
                  trivial: { value: true, probability: 0.9 }
                }
              }
            }
          }
        })
        const untrivial = withDecision()

        expect(trivial.get('.jev-decision-trivial').text()).toBeTruthy()
        expect(untrivial.find('.jev-decision-trivial').exists()).toBe(false)
      })

      it('shows the large-context flag only when the local decision preferred one', () => {
        const large = withDecision({
          jev: {
            ...READY_JEV,
            enabled: true,
            routing: {
              phase: 'decided',
              decision: {
                ...DECISION.decision,
                parts: {
                  ...DECISION.decision.parts,
                  largeContext: { value: true, probability: 0.9 }
                }
              }
            }
          }
        })
        const notLarge = withDecision()

        expect(large.get('.jev-decision-large-context').text()).toBeTruthy()
        expect(notLarge.find('.jev-decision-large-context').exists()).toBe(false)
      })
    })

    /*
     * #608 T3. `parts.model` (jev-routing-profiles T3/#608) is a THIRD
     * routing step, but never `JevRouteAnsweredPart`-shaped: it is a Noul
     * per candidate plus a tie-breaking Choice, not one Choice with a
     * `confidence`. Its three `applied` states — `'answered'`,
     * `'only-candidate'`, `'safe-default'` — each read differently on the
     * per-part line, per the issue's own acceptance criterion: never call a
     * safe default or a forced-single-candidate pick "Jev chose".
     */
    describe('the model step (#608)', () => {
      // Arrow, not `function` — a nested `function` declaration resets
      // TypeScript's control-flow narrowing of `DECISION` (typed as the
      // wider `JevState['routing']` union) back to the full union, even
      // though `DECISION` is a `const` initialized with a `'decided'`
      // literal; an arrow function here keeps `DECISION.decision` typed.
      const withModel = (model: Record<string, unknown>) => {
        return withDecision({
          jev: {
            ...READY_JEV,
            enabled: true,
            routing: {
              phase: 'decided',
              decision: {
                ...DECISION.decision,
                parts: { ...DECISION.decision.parts, model }
              }
            }
          }
        })
      }

      it('credits Jev’s own pick with the winning candidate’s fit percentage', () => {
        const text = withModel({
          value: 'gpt-5.6-sol',
          applied: 'answered',
          probability: 0.82
        })
          .get('.jev-decision-parts')
          .text()

        expect(text).toContain('Jev picked the model')
        expect(text).toContain('82%')
        expect(text).not.toContain('Tie broken')
      })

      it('names the Choice tiebreak when one broke a Noul tie', () => {
        const text = withModel({
          value: 'gpt-5.6-sol',
          applied: 'answered',
          probability: 0.55,
          choiceProbability: 0.61
        })
          .get('.jev-decision-parts')
          .text()

        expect(text).toContain('Jev picked the model')
        expect(text).toContain('55%')
        expect(text).toContain("Tie broken by Jev's ranking")
        expect(text).toContain('61%')
      })

      it('says plainly that only one model fit the tier — neither Jev’s own pick nor a safe default', () => {
        const text = withModel({ value: 'gpt-5.6-sol', applied: 'only-candidate' })
          .get('.jev-decision-parts')
          .text()

        expect(text).toContain('Only one model fits that tier')
        expect(text).not.toContain('Jev picked the model')
        expect(text).not.toContain('unsure')
      })

      /*
       * Every `JevModelFallbackReason` maps to fixed words — the union is
       * `JevFallbackReason` (request 2's own way of failing) plus
       * `'no-live-model'`, the one reason that predates #608 entirely: no
       * launchable, catalogued model existed at any tier step, so there was
       * never a candidate and never a second request either.
       */
      it.each([
        ['no-key', 'no TypeSafe key is set'],
        ['no-launchable-provider', 'no launchable provider to choose from'],
        ['unreachable', 'Jev could not be reached'],
        ['timeout', 'Jev took too long'],
        ['rate-limited', 'Jev is rate-limited right now'],
        ['unauthorized', 'TypeSafe rejected the API key'],
        ['low-confidence', 'Jev was not confident enough'],
        ['invalid-response', "Jev's answer could not be used"],
        ['budget-exceeded', "the prompt and catalogue do not fit Jev's request budget"],
        ['no-live-model', 'no live model exists for this provider and tier']
      ])(
        'maps the %s fallback reason to fixed words, and says the local choice was used',
        (reason, words) => {
          const text = withModel({ applied: 'safe-default', reason })
            .get('.jev-decision-parts')
            .text()

          expect(text).toContain('Jev could not pick the model')
          expect(text).toContain(words)
          expect(text).toContain('local choice was used')
        }
      )
    })

    /*
     * #608's own bug: the Add Panel card said "Jev chose opencode, Big
     * Pickle (19% confidence)" when the provider was a SAFE DEFAULT at 19%
     * (below the floor) and the model was picked locally — crediting Jev
     * with a choice it never made, and showing a confidence number that was
     * never Jev's own answer about the thing that launched.
     */
    describe('#608 regression: the exact bug case', () => {
      function withIssue608() {
        return withDecision({
          jev: {
            ...READY_JEV,
            enabled: true,
            routing: {
              phase: 'decided',
              decision: {
                kind: 'decision',
                provider: 'opencode',
                model: 'big-pickle',
                confidence: 0.75,
                truncated: false,
                tier: 'frontier',
                parts: {
                  provider: { value: 'opencode', confidence: 0.19, applied: 'safe-default' },
                  tier: { value: 'frontier', confidence: 0.92, applied: 'answered' },
                  trivial: { value: false, probability: 0.05 },
                  largeContext: { value: false, probability: 0.05 },
                  model: { value: 'big-pickle', applied: 'answered', probability: 0.75 }
                }
              }
            }
          }
        })
      }

      it('never says "Jev chose" when the named provider was a safe default', () => {
        expect(withIssue608().get('.jev-decision-summary').text()).not.toContain('Jev chose')
      })

      it('never shows the discarded 19% provider confidence as the headline figure', () => {
        const summary = withIssue608().get('.jev-decision-summary').text()

        expect(summary).not.toContain('19%')
        // The MIN over the ANSWERED parts only — tier 92%, model 75% — never
        // the excluded safe-default provider figure.
        expect(summary).toContain('75%')
      })

      it('still credits Jev for the tier and the model on the per-part line, and names the provider as unsure', () => {
        const text = withIssue608().get('.jev-decision-parts').text()

        expect(text).toContain('unsure about the provider')
        expect(text).toContain('19%')
        expect(text).toContain('Jev picked the model')
        expect(text).toContain('75%')
      })
    })

    it('applies the decision to the pickers themselves — the chip and the model select', () => {
      const wrapper = withDecision({
        modelPicker: {
          visible: true,
          models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
          disabled: false,
          note: null
        }
      })

      // AMENDED for #635: the checked radio, under the tool's own name.
      expect(wrapper.get('select[aria-label="Model"]').element).toBeTruthy()
      expect(
        wrapper
          .findAll(CHIPS)
          .find((chip) => chip.attributes('aria-checked') === 'true')
          ?.text()
      ).toBe('Codex')
    })

    it('dismisses on its own control, reporting the gesture and nothing else', async () => {
      const wrapper = withDecision()

      await wrapper.get('.jev-dismiss').trigger('click')

      expect(wrapper.emitted('dismiss-jev')).toHaveLength(1)
    })

    /*
     * Coverage gap named by the #509/#523 T4 verifier (Engram
     * odd/jev-launch-routing/progress, obs #881): "close-with-live-decision
     * untested directly." The close control has to keep working while the
     * card is on screen — nothing about a live decision should intercept or
     * swallow the gesture.
     */
    it('can still be closed while the decision card is showing', async () => {
      const wrapper = withDecision()
      // AMENDED for #635 (was: `.jev-decision` and `.launch-close`): the card's summary line.
      expect(wrapper.find('.jev-decision-summary').exists()).toBe(true)

      await wrapper.get(CLOSE).trigger('click')

      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(wrapper.emitted('dismiss-jev')).toBeUndefined()
    })

    /*
     * AMENDED for #635 (was: `.jev-decision` absent, alongside the chips and the composer). The
     * chips and the prompt stay drawn now, but the card still goes: its Dismiss would put the
     * pickers back under a launch already in flight, and its "press Send the dwarf in" can no
     * longer be acted on.
     */
    it('is gone once the session has launched, Dismiss with it', () => {
      const wrapper = panel({
        chosen: 'codex',
        phase: 'submitted-spawning',
        enabled: true,
        prompt: 'dig the east gallery',
        jev: { ...READY_JEV, enabled: true, routing: DECISION }
      })

      expect(wrapper.find('.jev-decision-summary').exists()).toBe(false)
      expect(wrapper.find('.jev-dismiss').exists()).toBe(false)
    })
  })

  describe('the fallback line', () => {
    // AMENDED for #523: `chosen: 'claude'` plus a fallback is exactly the case
    // that DOES launch on the pickers' values — #509's own — so the promise
    // the state machine would have recorded for it is recorded here. The
    // no-chip refusal beside it is asserted in its own block below.
    function fellBackWith(reason: string, confidence?: number) {
      return panel({
        chosen: 'claude',
        phase: 'prompt-ready',
        enabled: true,
        prompt: 'dig the east gallery',
        jev: {
          ...READY_JEV,
          enabled: true,
          launchedOnFallback: true,
          routing: { phase: 'fellBack', reason, confidence }
        }
      })
    }

    it.each([
      ['no-key', 'No TypeSafe key is set'],
      ['no-launchable-provider', 'No launchable provider to choose from'],
      ['unreachable', 'Jev could not be reached'],
      ['timeout', 'Jev took too long'],
      ['rate-limited', 'Jev is rate-limited right now'],
      ['unauthorized', 'TypeSafe rejected the API key'],
      ['invalid-response', "Jev's answer could not be used"],
      ['budget-exceeded', "The prompt and catalogue do not fit Jev's request budget"]
    ])(
      'names %s in the panel’s own words, and says the launch happened anyway',
      (reason, sentence) => {
        const text = fellBackWith(reason).get('.jev-fallback').text()

        expect(text).toContain(sentence)
        expect(text).toContain("Launched with your pickers' values.")
      }
    )

    it('names the confidence percentage for a low-confidence fallback', () => {
      const text = fellBackWith('low-confidence', 0.42).get('.jev-fallback').text()

      expect(text).toContain('42%')
      expect(text).toContain('not confident enough')
    })

    it('stays visible once the launch it explains has started', () => {
      const wrapper = panel({
        chosen: 'claude',
        phase: 'submitted-spawning',
        enabled: true,
        prompt: 'dig the east gallery',
        jev: {
          ...READY_JEV,
          enabled: true,
          launchedOnFallback: true,
          routing: { phase: 'fellBack', reason: 'timeout' }
        }
      })

      expect(wrapper.get('.jev-fallback').text()).toContain('Jev took too long')
    })

    /*
     * Coverage gap named by the #509/#523 T4 verifier (Engram
     * odd/jev-launch-routing/progress, obs #881): "fallback visibility pinned
     * only for submitted-spawning." The line's own template comment says it
     * has to survive past `launched` becoming true either way `launched` can
     * become true — the test above only ever pinned the held/detached-holding
     * `submitted-spawning` phase; this pins the OTHER one, a launch main is
     * not holding (`started-detached`, #168/#191).
     */
    it('stays visible for a detached launch too, not only a held one', () => {
      const wrapper = panel({
        chosen: 'codex',
        phase: 'started-detached',
        enabled: true,
        prompt: 'dig the east gallery',
        jev: {
          ...READY_JEV,
          enabled: true,
          launchedOnFallback: true,
          routing: { phase: 'fellBack', reason: 'timeout' }
        }
      })

      expect(wrapper.get('.jev-fallback').text()).toContain('Jev took too long')
    })

    /*
     * Issue #523. With the toggle now a full entry path, a fallback can arrive
     * with no chip behind it — and then nothing launched, so the line must say
     * what stands instead: the prompt was kept, and a provider is what the
     * launch still needs. The `launchedOnFallback` flag is `launchState`'s
     * reading of that moment, decided when the answer lands, never re-read
     * off the chips that may move afterwards.
     */
    describe('the fallback with no chip', () => {
      function fellBackAlone(reason: string, confidence?: number) {
        return panel({
          // No `chosen`: this is the toggle-as-entry-path panel, composer open
          // on Jev alone exactly as `launchState` unlocks it.
          phase: 'prompt-ready',
          enabled: true,
          placeholder: COMPOSER_ENABLED_PLACEHOLDER,
          prompt: 'dig the east gallery',
          jev: {
            ...READY_JEV,
            enabled: true,
            launchedOnFallback: false,
            routing: { phase: 'fellBack', reason, confidence }
          }
        })
      }

      it('says the prompt was kept and a provider must be chosen, instead of claiming a launch', () => {
        const text = fellBackAlone('timeout').get('.jev-fallback').text()

        expect(text).toContain('Jev took too long')
        expect(text).toContain('Your prompt was kept')
        expect(text).toContain('choose a provider')
        expect(text).not.toContain("Launched with your pickers' values.")
      })

      it('keeps the reason wording per name, with the refusal as the only changed half', () => {
        // The reason sentences themselves are #509's, untouched; only the
        // ending split moves. One named reason is enough to pin the split.
        expect(fellBackAlone('rate-limited').get('.jev-fallback').text()).toContain(
          'Jev is rate-limited right now'
        )
      })

      it('still names the confidence for a low-confidence no-chip fallback', () => {
        const text = fellBackAlone('low-confidence', 0.42).get('.jev-fallback').text()

        expect(text).toContain('42%')
        expect(text).toContain('not confident enough')
        expect(text).toContain('Your prompt was kept')
      })
    })

    /*
     * jev-routing-profiles T4. `fallbackTo` is APPLIED to the pickers
     * (launchState.jevAnswered's own detour), so this line says so and asks
     * for the confirming Enter, instead of the #509/#523 endings above,
     * which only ever describe the CURRENT chips.
     */
    describe('the fallback with a configured default (T4)', () => {
      function fellBackWithDefault(overrides: Record<string, unknown> = {}) {
        return panel({
          chosen: 'codex',
          phase: 'known-provider-ready',
          modelPicker: {
            visible: true,
            models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
            disabled: false,
            note: null
          },
          jev: {
            ...READY_JEV,
            enabled: true,
            routing: {
              phase: 'fellBack',
              reason: 'timeout',
              appliedDefault: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
            }
          },
          ...overrides
        })
      }

      it('says Jev could not decide, names the reason, and sets the default below', () => {
        const text = fellBackWithDefault().get('.jev-fallback').text()

        expect(text).toContain('Jev could not decide')
        expect(text).toContain('Jev took too long')
        expect(text).toContain('Your default')
        expect(text).toContain('codex')
        expect(text).toContain('GPT-5.6 Sol')
        expect(text).toContain('high')
        expect(text).toContain('press Launch again')
      })

      it('never claims a launch already happened, unlike the plain #509 ending', () => {
        const text = fellBackWithDefault().get('.jev-fallback').text()

        expect(text).not.toContain("Launched with your pickers' values.")
      })

      it('offers Dismiss, the same way the decision card does, so the applied default can be put back', async () => {
        // The default was applied to the pickers exactly like a decision, and
        // clearJevDecision already knows how to restore what stood before —
        // so the affordance has to be here too, not only on the decided card,
        // or the person's one way back is to retype the prompt.
        const wrapper = fellBackWithDefault()

        await wrapper.get('.jev-fallback-dismiss').trigger('click')

        expect(wrapper.emitted('dismiss-jev')).toHaveLength(1)
      })

      it('shows no Dismiss on a plain fallback that applied nothing', () => {
        const wrapper = panel({
          chosen: 'claude',
          enabled: true,
          prompt: 'dig the east gallery',
          jev: { ...READY_JEV, enabled: true, routing: { phase: 'fellBack', reason: 'timeout' } }
        })

        expect(wrapper.find('.jev-fallback-dismiss').exists()).toBe(false)
      })

      it('resolves the model off the picker’s own catalogue, falling back to the raw id', () => {
        const text = fellBackWithDefault({
          modelPicker: { visible: true, models: [], disabled: true, note: null }
        })
          .get('.jev-fallback')
          .text()

        expect(text).toContain('gpt-5.6-sol')
      })

      it('omits the model and effort pieces the default never named', () => {
        const text = fellBackWithDefault({
          jev: {
            ...READY_JEV,
            enabled: true,
            routing: {
              phase: 'fellBack',
              reason: 'timeout',
              appliedDefault: { provider: 'codex' }
            }
          }
        })
          .get('.jev-fallback')
          .text()

        expect(text).toContain('Your default')
        expect(text).toContain('codex')
      })
    })
  })

  /*
   * Issue #523's checkbox: visible exactly when the toggle is pressable, its
   * tick carried in from the state, and its press reported as its own gesture
   * — the component decides nothing about what auto-accept means at submit.
   *
   * AMENDED for #635: the design's Auto-accept is a switch beside Let Jev choose, drawn in every
   * state as the design draws Jev, and pressable exactly when the toggle is.
   */
  describe('the auto-accept checkbox (#523)', () => {
    // AMENDED for #635 (was: the `.jev-auto` checkbox present only when ready, absent otherwise).
    it('sits beside the pressable toggle, pressable exactly when it is', () => {
      const ready = panel({ jev: READY_JEV })
      expect(ready.get(JEV_AUTO).attributes('disabled')).toBeUndefined()
      expect(ready.get(JEV_TOGGLE).element.parentElement).toBe(
        ready.get(JEV_AUTO).element.parentElement
      )
      expect(ready.get(JEV_AUTO).element.parentElement!.textContent).toContain('Auto-accept')

      expect(panel({ jev: HIDDEN_JEV }).get(JEV_AUTO).attributes('disabled')).toBeDefined()
      const unavailable: JevState = {
        availability: 'unavailable',
        unavailableReason: 'encryption-unavailable',
        enabled: false,
        autoAccept: false,
        routing: { phase: 'idle' },
        previousChoice: null,
        launchedOnFallback: false
      }
      expect(panel({ jev: unavailable }).get(JEV_AUTO).attributes('disabled')).toBeDefined()
    })

    // AMENDED for #635 (was: the checkbox's `checked`): the switch's aria-checked.
    it('draws the tick from the state, checked and unchecked', () => {
      const off = panel({ jev: READY_JEV }).get(JEV_AUTO)
      const on = panel({ jev: { ...READY_JEV, autoAccept: true } }).get(JEV_AUTO)

      expect(off.attributes('aria-checked')).toBe('false')
      expect(on.attributes('aria-checked')).toBe('true')
    })

    it('reports its press and nothing else', async () => {
      const wrapper = panel({ jev: READY_JEV })

      await wrapper.get(JEV_AUTO).trigger('click')

      expect(wrapper.emitted('toggle-jev-auto')).toHaveLength(1)
      expect(wrapper.emitted('toggle-jev')).toBeUndefined()
    })
  })
})

/*
 * ADDED for #566 T4: the launch panel's chips and its close answer a pointer
 * through the shared vocabulary. The chips are the "profile chips" the task
 * names - one per launchable provider, plus Other - and they are the first
 * thing anyone opening this panel aims at.
 *
 * Spelled out rather than counted, so a control added later without feedback
 * fails here.
 */
describe('AddPanel press and hover feedback', () => {
  /*
   * REMOVED for #635: 'routes the close and every provider chip through motion.button with the
   * shared variants'. The redesigned panel draws the design's atoms — ActionButton for Close and
   * Send the dwarf in, ChoiceChip for the suppliers — whose hover and press are their own states
   * in their own stylesheets (components.md, atoms/button and atoms/chip), as the MessagePanel's
   * controls are since its rebuild. No motion.button is left here for the case to count.
   */

  // AMENDED for #635 (was: `.launch-close` named "Close the launch panel", chips with
  // aria-pressed and data-state): the design's Close, and radios with aria-checked.
  it('leaves the chips and the close with the tag, state and press they had', async () => {
    const wrapper = panel({ chosen: 'claude' })

    const close = wrapper.get(CLOSE)
    expect(close.element.tagName).toBe('BUTTON')
    expect(close.attributes('type')).toBe('button')
    expect(close.attributes('aria-label')).toBe('Close')
    await close.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    const chips = wrapper.findAll(CHIPS)
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect(chip.element.tagName).toBe('BUTTON')
      expect(chip.attributes('aria-checked')).toBeDefined()
    }
    expect(chips.filter((chip) => chip.attributes('aria-checked') === 'true')).toHaveLength(1)

    await chips[0]!.trigger('click')
    expect(wrapper.emitted('choose')).toHaveLength(1)
  })
})

/*
 * APPENDED for #635, from a live run: Other… with a command typed and a prompt written could never
 * launch, because the gate waited on the command's Enter that the old panel forced (its prompt was
 * disabled until then) and the redesigned one never asks for. A command in the box is a chosen
 * supplier; launching commits it first, so the launch model reads exactly what main's panel sent.
 */
describe('a custom command of the person’s own', () => {
  function typed(overrides: Record<string, unknown> = {}) {
    return panel({
      chosen: OTHER_CHOICE,
      phase: 'other-command-required',
      enabled: false,
      command: 'my-agent --yes',
      prompt: 'dig',
      ...overrides
    })
  }

  it('is a chosen supplier once it is typed, before any Enter', () => {
    const wrapper = typed()

    expect(wrapper.get(WHY).text()).toBe('Ready. The dwarf walks into DwarfAI-Miners.')
    expect(wrapper.get(LAUNCH).attributes('disabled')).toBeUndefined()
  })

  it('commits the command, then launches, on Ctrl+Enter and on Send the dwarf in', async () => {
    const said: string[] = []
    const wrapper = typed({
      listeners: { onCommit: () => said.push('commit'), onSubmit: () => said.push('submit') }
    })

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await wrapper.get(LAUNCH).trigger('click')

    expect(said).toEqual(['commit', 'submit', 'commit', 'submit'])
  })

  it('still waits for a command while the box holds only spaces', async () => {
    const wrapper = typed({ command: '   ' })

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })

    expect(wrapper.get(WHY).text()).toBe('Choose a supplier, or let Jev choose.')
    expect(wrapper.get(LAUNCH).attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})

/*
 * APPENDED for #635, from a live run: Ctrl+Enter pressed while an input method was still composing
 * launched with the text it had not committed yet. A key that belongs to a composition is the
 * input method's, in both fields, whatever it would otherwise do.
 */
describe('keys that belong to an input method composition', () => {
  const ready = () =>
    panel({ chosen: 'claude', phase: 'prompt-ready', enabled: true, prompt: 'dig here' })

  it('never launch from the prompt', async () => {
    const wrapper = ready()

    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
    await wrapper.get(PROMPT).trigger('keydown', { key: 'Enter', metaKey: true, keyCode: 229 })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('never commit the custom command', async () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })

    await wrapper.get(COMMAND).setValue('my-agent')
    await wrapper.get(COMMAND).trigger('keydown', { key: 'Enter', isComposing: true })
    await wrapper.get(COMMAND).trigger('keydown', { key: 'Enter', keyCode: 229 })

    expect(wrapper.emitted('commit')).toBeUndefined()
  })
})

/*
 * APPENDED for #635: the Add panel focuses its first control when it opens (screens/shell.md,
 * Accessibility, and Where focus goes: `focusFirst()` is the first supplier chip), so the keyboard
 * is never left on the page body.
 */
describe('focus when the panel opens', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('lands on the first supplier chip', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const wrapper = panel({ attachTo: host })
    await flushPromises()

    expect(document.activeElement).toBe(wrapper.findAll(CHIPS)[0]!.element)
    wrapper.unmount()
  })
})
