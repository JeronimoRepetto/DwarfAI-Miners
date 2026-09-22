// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { motion } from 'motion-v'
import { pressHoverVariants } from '../../lib/shell/presence'
import {
  COMMAND_PLACEHOLDER,
  COMPOSER_DISABLED_PLACEHOLDER,
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

function panel(overrides: Partial<Record<string, unknown>> = {}) {
  const chosen = (overrides.chosen ?? null) as 'claude' | 'codex' | typeof OTHER_CHOICE | null
  return mount(AddPanel, {
    props: {
      chips: providerChips([CLAUDE, CODEX], chosen),
      phase: (overrides.phase ?? 'provider-selection') as LaunchPhase,
      enabled: (overrides.enabled ?? false) as boolean,
      placeholder: (overrides.placeholder ?? COMPOSER_DISABLED_PLACEHOLDER) as string,
      command: (overrides.command ?? '') as string,
      prompt: (overrides.prompt ?? '') as string,
      refusal: (overrides.refusal ?? null) as string | null,
      error: (overrides.error ?? null) as string | null,
      modelPicker: (overrides.modelPicker ?? HIDDEN_MODEL_PICKER) as ModelPicker,
      effortPicker: (overrides.effortPicker ?? HIDDEN_EFFORT_PICKER) as EffortPicker,
      permissionsVisible: (overrides.permissionsVisible ?? false) as boolean,
      jev: (overrides.jev ?? HIDDEN_JEV) as JevState
    }
  })
}

describe('the chip row', () => {
  it('draws one chip per detected provider, with Other last', () => {
    const chips = panel().findAll('.provider-chip')

    expect(chips.map((chip) => chip.text())).toEqual(['claude', 'codex', 'Other'])
  })

  it('publishes each chip’s state, so the design’s three treatments are drawable', () => {
    const chips = panel({ chosen: 'claude' }).findAll('.provider-chip')

    expect(chips.map((chip) => chip.attributes('data-state'))).toEqual([
      'selected',
      'unselected',
      'unselected'
    ])
  })

  it('asks for the chip that was clicked and decides nothing itself', async () => {
    const wrapper = panel()

    await wrapper.findAll('.provider-chip')[1]?.trigger('click')

    expect(wrapper.emitted('choose')).toEqual([['codex']])
  })

  it('says which chip is pressed for anything not looking at it', () => {
    const chips = panel({ chosen: OTHER_CHOICE }).findAll('.provider-chip')

    expect(chips.map((chip) => chip.attributes('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })
})

describe('the composer gate', () => {
  it('is disabled with the source’s instruction before a choice', () => {
    const composer = panel().get('.launch-input')

    expect(composer.attributes('disabled')).toBeDefined()
    expect(composer.attributes('placeholder')).toBe(COMPOSER_DISABLED_PLACEHOLDER)
  })

  it('is enabled and invites a prompt once the gate opens', () => {
    const composer = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      enabled: true,
      placeholder: COMPOSER_ENABLED_PLACEHOLDER
    }).get('.launch-input')

    expect(composer.attributes('disabled')).toBeUndefined()
    expect(composer.attributes('placeholder')).toBe(COMPOSER_ENABLED_PLACEHOLDER)
  })

  // AMENDED for #431 (was: 'caps the prompt at the same length a delivered
  // message is capped at', asserting a maxlength of MAX_DWARF_TEXT_CHARS). That
  // ceiling is the command line a MESSAGE's channel is spawned with; a launch
  // prompt goes down the child's stdin or straight onto a held stream and has
  // no command line to fit inside, so the attribute was cutting a paste for a
  // bound that does not exist. It asserts the absence now, which is the
  // behaviour — see prepareLaunchPrompt, which lost the matching slice.
  it('lets the box hold whatever was pasted: a launch prompt has no ceiling', () => {
    expect(panel().get('.launch-input').attributes('maxlength')).toBeUndefined()
  })
})

describe('the custom-command input', () => {
  it('is absent until Other is chosen', () => {
    expect(
      panel({ chosen: 'claude', phase: 'known-provider-ready' }).find('.launch-command').exists()
    ).toBe(false)
  })

  it('appears with the source’s own placeholder when Other is chosen', () => {
    const command = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' }).get(
      '.launch-command'
    )

    expect(command.attributes('placeholder')).toBe(COMMAND_PLACEHOLDER)
  })

  it('commits on Enter and reports what was typed', async () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })
    const command = wrapper.get('.launch-command')

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

  it('is absent before a real provider chip is chosen', () => {
    expect(panel().find('.launch-tuning').exists()).toBe(false)
  })

  it('is absent for Other, which has no provider identity for it', () => {
    expect(
      panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })
        .find('.launch-tuning')
        .exists()
    ).toBe(false)
  })

  it('draws one option per model the picker offers, labelled where it has one', () => {
    const select = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      modelPicker: LIVE_MODEL_PICKER
    }).get('select[aria-label="Model"]')

    expect(select.findAll('option').map((option) => option.text())).toEqual(['Sonnet', 'Haiku'])
  })

  it('disables the model select with the picker’s own reason for a provider main could not ask', () => {
    const wrapper = panel({
      chosen: 'antigravity',
      phase: 'known-provider-ready',
      modelPicker: { visible: true, models: [], disabled: true, note: NO_MODEL_LIST }
    })

    expect(wrapper.get('select[aria-label="Model"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.tuning-note').text()).toBe(NO_MODEL_LIST)
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
    expect(wrapper.get('.tuning-note').text()).toBe(MODEL_HISTORY_SOURCE)
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

  it('draws no effort select for a provider the picker says has none', () => {
    const wrapper = panel({
      chosen: 'antigravity',
      phase: 'known-provider-ready',
      modelPicker: { visible: true, models: [], disabled: true, note: NO_MODEL_LIST },
      effortPicker: { visible: false, efforts: [] }
    })

    expect(wrapper.find('select[aria-label="Effort"]').exists()).toBe(false)
  })

  it('draws one option per effort level, and reports the one chosen', async () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      modelPicker: LIVE_MODEL_PICKER,
      effortPicker: { visible: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
    })
    const select = wrapper.get('select[aria-label="Effort"]')

    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])

    await select.setValue('xhigh')
    expect(wrapper.emitted('effort')).toEqual([['xhigh']])
  })

  it('draws no permissions select outside a held Claude session', () => {
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

    expect(wrapper.find('select[aria-label="Permissions"]').exists()).toBe(false)
  })

  it('draws every non-bypass permission mode for a held Claude session, and reports the one chosen', async () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      modelPicker: LIVE_MODEL_PICKER,
      permissionsVisible: true
    })
    const select = wrapper.get('select[aria-label="Permissions"]')

    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'auto'
    ])
    expect(select.findAll('option').map((option) => option.text())).not.toContain(
      'bypassPermissions'
    )

    await select.setValue('plan')
    expect(wrapper.emitted('permissionMode')).toEqual([['plan']])
  })

  it('is absent once the session has launched, alongside the chips and the composer', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'submitted-spawning',
      enabled: true,
      prompt: 'dig the east gallery',
      modelPicker: LIVE_MODEL_PICKER
    })

    expect(wrapper.find('.launch-tuning').exists()).toBe(false)
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

  it('submits on Enter', async () => {
    const wrapper = ready()

    await wrapper.get('.launch-input').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('writes a newline on Shift+Enter instead of submitting', async () => {
    const wrapper = ready()

    await wrapper.get('.launch-input').trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('does not submit from a composer the gate has not opened', async () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })

    await wrapper.get('.launch-input').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})

describe('what the panel says out loud', () => {
  it('states why the chosen chip cannot start a session', () => {
    const wrapper = panel({ chosen: 'codex', phase: 'known-provider-ready', refusal: CODEX.reason })

    expect(wrapper.get('.launch-note').text()).toBe(CODEX.reason)
  })

  it('carries a refused launch’s own reason, in its own alert', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'prompt-ready',
      enabled: true,
      error: 'Claude Code is not installed on this machine.'
    })

    expect(wrapper.get('.launch-alert').text()).toBe(
      'Claude Code is not installed on this machine.'
    )
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

    expect(wrapper.get('.launch-alert').text()).toBe('codex: another instance is already running')
    const composer = wrapper.get('.launch-input')
    expect(composer.attributes('disabled')).toBeUndefined()
    expect((composer.element as HTMLTextAreaElement).value).toBe('dig the east gallery')
  })

  it('closes when its close control is used', async () => {
    const wrapper = panel()

    await wrapper.get('.launch-close').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape, as every panel here does', async () => {
    const wrapper = panel()

    await wrapper.get('.add-panel').trigger('keydown.escape')

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
   * `launch.md` step 3 — insert the submitted prompt as the conversation's
   * first message — happens here rather than being invented: between Enter and
   * the dwarf's arrival there is no MessagePanel to hold it, and this is the
   * one window in which the prompt exists nowhere else on screen. Once the
   * dwarf lands, the MessagePanel draws main's own record of it and this view
   * is gone, so it is never shown twice.
   */
  it('shows the submitted prompt where its first message belongs', () => {
    expect(spawning().get('.launch-first-message').text()).toBe('dig the east gallery')
  })

  it('says a session is starting rather than looking like nothing happened', () => {
    expect(spawning().get('.launch-note').text()).toBeTruthy()
  })

  it('takes the chips and the composer away while one is in flight', () => {
    const wrapper = spawning()

    expect(wrapper.find('.provider-chip').exists()).toBe(false)
    expect(wrapper.find('.launch-input').exists()).toBe(false)
  })

  it('can still be closed, so a launch that never lands is not a trap', async () => {
    const wrapper = spawning()

    await wrapper.get('.launch-close').trigger('click')

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
    const note = detached().get('.launch-note').text()

    expect(note).toBeTruthy()
    expect(note.toLowerCase()).toContain('mine')
  })

  it('never claims the panel is still looking for it', () => {
    // The spawning copy promises the panel will find it. That promise cannot be
    // kept for a detached launch, so this state must not borrow the wording.
    expect(detached().get('.launch-note').text().toLowerCase()).not.toContain('as soon as')
  })

  it('takes the composer away, so the same prompt is not sent twice', () => {
    const wrapper = detached()

    expect(wrapper.find('.launch-input').exists()).toBe(false)
    expect(wrapper.find('.provider-chip').exists()).toBe(false)
  })

  it('can be closed, which is the only way out of it', async () => {
    const wrapper = detached()

    await wrapper.get('.launch-close').trigger('click')

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
        largeContext: { value: false, probability: 0.05 }
      }
    }
  }

  it('is absent with no key configured — #509’s own first option', () => {
    expect(panel({ jev: HIDDEN_JEV }).find('.jev-toggle').exists()).toBe(false)
    expect(panel({ jev: HIDDEN_JEV }).find('.jev-unavailable-reason').exists()).toBe(false)
  })

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

    expect(wrapper.get('.jev-toggle').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.jev-unavailable-reason').text()).toBeTruthy()
  })

  it('is a pressable toggle once ready, reporting the press and nothing else', async () => {
    const wrapper = panel({ jev: READY_JEV })
    const toggle = wrapper.get('.jev-toggle')

    expect(toggle.attributes('disabled')).toBeUndefined()
    expect(toggle.attributes('aria-pressed')).toBe('false')

    await toggle.trigger('click')

    expect(wrapper.emitted('toggle-jev')).toHaveLength(1)
  })

  it('shows the toggle pressed once the person has turned it on', () => {
    const wrapper = panel({ jev: { ...READY_JEV, enabled: true } })

    expect(wrapper.get('.jev-toggle').attributes('aria-pressed')).toBe('true')
  })

  it('says it is asking while the ask is in flight', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      jev: ASKING_JEV
    })

    expect(wrapper.get('.jev-status').text()).toBe('Asking Jev…')
  })

  it('refuses a second Enter while Jev is being asked', async () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'prompt-ready',
      enabled: true,
      prompt: 'dig here',
      jev: ASKING_JEV
    })

    await wrapper.get('.launch-input').trigger('keydown', { key: 'Enter' })

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

    it('applies the decision to the pickers themselves — the chip and the model select', () => {
      const wrapper = withDecision({
        modelPicker: {
          visible: true,
          models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
          disabled: false,
          note: null
        }
      })

      expect(wrapper.get('select[aria-label="Model"]').element).toBeTruthy()
      expect(
        wrapper
          .findAll('.provider-chip')
          .find((chip) => chip.attributes('data-state') === 'selected')
          ?.text()
      ).toBe('codex')
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
      expect(wrapper.find('.jev-decision').exists()).toBe(true)

      await wrapper.get('.launch-close').trigger('click')

      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(wrapper.emitted('dismiss-jev')).toBeUndefined()
    })

    it('is gone once the session has launched, alongside the chips and the composer', () => {
      const wrapper = panel({
        chosen: 'codex',
        phase: 'submitted-spawning',
        enabled: true,
        prompt: 'dig the east gallery',
        jev: { ...READY_JEV, enabled: true, routing: DECISION }
      })

      expect(wrapper.find('.jev-decision').exists()).toBe(false)
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
   */
  describe('the auto-accept checkbox (#523)', () => {
    it('sits beside the pressable toggle, and nowhere else', () => {
      const ready = panel({ jev: READY_JEV })
      expect(ready.find('.jev-auto').exists()).toBe(true)
      expect(ready.get('.jev-row').text()).toContain("Auto-accept Jev's choice")

      expect(panel({ jev: HIDDEN_JEV }).find('.jev-auto').exists()).toBe(false)
      const unavailable: JevState = {
        availability: 'unavailable',
        unavailableReason: 'encryption-unavailable',
        enabled: false,
        autoAccept: false,
        routing: { phase: 'idle' },
        previousChoice: null,
        launchedOnFallback: false
      }
      expect(panel({ jev: unavailable }).find('.jev-auto').exists()).toBe(false)
    })

    it('draws the tick from the state, checked and unchecked', () => {
      const off = panel({ jev: READY_JEV }).get('.jev-auto')
      const on = panel({ jev: { ...READY_JEV, autoAccept: true } }).get('.jev-auto')

      expect((off.element as HTMLInputElement).checked).toBe(false)
      expect((on.element as HTMLInputElement).checked).toBe(true)
    })

    it('reports its press and nothing else', async () => {
      const wrapper = panel({ jev: READY_JEV })

      await wrapper.get('.jev-auto').setValue(true)

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
  it('routes the close and every provider chip through motion.button with the shared variants', () => {
    const wrapper = panel()
    const controls = wrapper.findAllComponents(motion.button)

    expect(controls.map((control) => control.classes()[0])).toEqual([
      'launch-close',
      ...wrapper.findAll('.provider-chip').map(() => 'provider-chip')
    ])
    for (const control of controls) {
      expect(control.props('whileHover')).toEqual(pressHoverVariants.whileHover)
      expect(control.props('whilePress')).toEqual(pressHoverVariants.whilePress)
    }
  })

  it('leaves the chips and the close with the tag, state and press they had', async () => {
    const wrapper = panel({ chosen: 'claude' })

    const close = wrapper.get('.launch-close')
    expect(close.element.tagName).toBe('BUTTON')
    expect(close.attributes('type')).toBe('button')
    expect(close.attributes('aria-label')).toBe('Close the launch panel')
    await close.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    const chips = wrapper.findAll('.provider-chip')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect(chip.element.tagName).toBe('BUTTON')
      expect(chip.attributes('aria-pressed')).toBeDefined()
      expect(chip.attributes('data-state')).toBeDefined()
    }
    expect(chips.filter((chip) => chip.attributes('aria-pressed') === 'true')).toHaveLength(1)

    await chips[0]!.trigger('click')
    expect(wrapper.emitted('choose')).toHaveLength(1)
  })
})
