// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  JevSettings as JevSettingsType
} from '../../types'
import { DEFAULT_JEV_PREFERENCES } from '../../types'
import JevPrivacyNotice from './JevPrivacyNotice.vue'
import JevSettings from './JevSettings.vue'

/*
 * AMENDED (#635): drawn as the design's rows of Settings › Integrations. The key field is the
 * design's input, its native control inside the `.jev-key-input` well; the routing profile is a
 * row of radio chips (aria-checked) whose one-line descriptions are the row's help; the delegation
 * checkbox is a switch in the danger zone; the privacy notice stands at the foot of the section
 * (JevPrivacyNotice, drawn by SettingsPanel whatever the Jev rows show). Each amended test says
 * what it was.
 */
const KEY = '.jev-key-input input'
const checkedProfiles = (wrapper: ReturnType<typeof render>) =>
  wrapper
    .findAll('.profile-option')
    .filter((option) => option.attributes('aria-checked') === 'true')
    .map((option) => option.text())

/**
 * The Jev section of the Settings screen (#509): the TypeSafe API key the
 * person enters, replaces and clears — this app never ships or generates
 * one — and the privacy notice the new outbound call requires.
 *
 * Presentational like every other settings piece: the stored verdict arrives
 * as a prop and every intent leaves as an event, so App.vue keeps owning the
 * IPC. The one thing kept LOCAL is the draft text of an unsaved key, which is
 * pure display state nothing outside this screen ever needs — the key itself
 * never reaches a store or a wire.
 */
/**
 * AMENDED for the #509 follow-up: `settings.preferences` is now required on
 * the wire type, and two new required props (`providers`, `catalogs`) feed
 * the default-launch pickers. Every existing call site here tests the KEY
 * controls and never touches either, so the defaults below keep them all
 * passing unchanged — no existing assertion changed.
 */
function render(
  settings: Partial<JevSettingsType> & { configured: boolean },
  props: Record<string, unknown> = {}
) {
  return mount(JevSettings, {
    props: {
      settings: { preferences: DEFAULT_JEV_PREFERENCES, ...settings },
      saving: false,
      providers: [] as AgentProviderOption[],
      catalogs: [] as AgentModelCatalog[],
      ...props
    }
  })
}

describe('JevSettings — rendering, not configured', () => {
  it('names the section', () => {
    expect(render({ configured: false }).text()).toContain('Jev')
  })

  it('offers a password-type input for the key, and a Save control', () => {
    const wrapper = render({ configured: false })
    const input = wrapper.find(KEY)
    expect(input.attributes('type')).toBe('password')
    expect(wrapper.find('.jev-save').exists()).toBe(true)
  })

  it('disables Save while the field is empty', () => {
    expect(render({ configured: false }).find('.jev-save').attributes('disabled')).toBeDefined()
  })

  it('never shows the Configured state without a key', () => {
    expect(render({ configured: false }).find('.jev-configured').exists()).toBe(false)
  })

  it('states plainly what leaves this machine and when, and where the key goes', () => {
    // #509's own constraint: the prompt and the provider/model list are sent
    // to TypeSafe's API when a session launches, and the key rides along as
    // the bearer token of that same request. A vague "Jev talks to a server"
    // would not be the honest notice this feature requires — and neither
    // would claiming the key never leaves, because it does, to exactly one
    // place.
    // AMENDED (#635): the notice is JevPrivacyNotice, at the foot of Integrations.
    const notice = mount(JevPrivacyNotice).text()
    expect(notice).toContain('api.typesafe.ai')
    expect(notice).toContain('prompt')
    expect(notice.toLowerCase()).toContain('encrypted')
    expect(notice).toContain('sent only to TypeSafe')
    expect(notice).not.toContain('never leaves')
  })
})

describe('JevSettings — typing and saving a key', () => {
  it('binds the input by hand (:value/@input), never v-model', async () => {
    // Same rule AudioSettings holds for its sliders: this asks, and redraws
    // only from what it was given, so a value main never confirmed cannot
    // sit in the box as if it had been.
    const wrapper = render({ configured: false })
    const input = wrapper.find(KEY)
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    expect((input.element as HTMLInputElement).value).toBe('sk-typesafe-abc123')
  })

  it('enables Save once something is typed', async () => {
    const wrapper = render({ configured: false })
    const input = wrapper.find(KEY)
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    expect(wrapper.find('.jev-save').attributes('disabled')).toBeUndefined()
  })

  it('emits save with the typed key on submit', async () => {
    const wrapper = render({ configured: false })
    const input = wrapper.find(KEY)
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    await wrapper.find('.jev-save').trigger('click')
    expect(wrapper.emitted('save')).toEqual([['sk-typesafe-abc123']])
  })

  it('disables Save while a save is already in flight', () => {
    const wrapper = render({ configured: false }, { saving: true })
    expect(wrapper.find('.jev-save').attributes('disabled')).toBeDefined()
  })

  it('clears the draft after a confirmed save, returning to the Configured state', async () => {
    const wrapper = render({ configured: false }, { saving: true })
    const input = wrapper.find(KEY)
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')

    // The confirmation: main answered configured while saving settled.
    await wrapper.setProps({
      saving: false,
      settings: { configured: true, preferences: DEFAULT_JEV_PREFERENCES }
    })
    expect(wrapper.find(KEY).exists()).toBe(false)
    expect(wrapper.find('.jev-configured').exists()).toBe(true)
  })

  it('keeps the draft when a save does not take, so the person need not retype it', async () => {
    const wrapper = render({ configured: false }, { saving: true })
    const input = wrapper.find(KEY)
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')

    // Refused: saving settled but main still reports unconfigured.
    await wrapper.setProps({
      saving: false,
      settings: { configured: false, preferences: DEFAULT_JEV_PREFERENCES }
    })
    expect((wrapper.find(KEY).element as HTMLInputElement).value).toBe('sk-typesafe-abc123')
  })
})

describe('JevSettings — the Configured state', () => {
  it('shows Configured with Replace and Clear, and no input', () => {
    const wrapper = render({ configured: true })
    expect(wrapper.find('.jev-configured').exists()).toBe(true)
    expect(wrapper.find('.jev-replace').exists()).toBe(true)
    expect(wrapper.find('.jev-clear').exists()).toBe(true)
    expect(wrapper.find(KEY).exists()).toBe(false)
  })

  it('emits clear when Clear is pressed', async () => {
    const wrapper = render({ configured: true })
    await wrapper.find('.jev-clear').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('shows the input again from Replace, to enter a new key over the old one', async () => {
    const wrapper = render({ configured: true })
    await wrapper.find('.jev-replace').trigger('click')
    expect(wrapper.find(KEY).exists()).toBe(true)
    expect(wrapper.find('.jev-configured').exists()).toBe(false)
  })

  it('emits save with the new key from the Replace flow', async () => {
    const wrapper = render({ configured: true })
    await wrapper.find('.jev-replace').trigger('click')
    const input = wrapper.find(KEY)
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-new'
    await input.trigger('input')
    await wrapper.find('.jev-save').trigger('click')
    expect(wrapper.emitted('save')).toEqual([['sk-typesafe-new']])
  })
})

describe('JevSettings — storage unavailable, no plaintext fallback', () => {
  it('shows the reason and hides the input and every control', () => {
    const wrapper = render({ configured: false, unavailableReason: 'encryption-unavailable' })
    expect(wrapper.find(KEY).exists()).toBe(false)
    expect(wrapper.find('.jev-save').exists()).toBe(false)
    expect(wrapper.find('.jev-configured').exists()).toBe(false)
    expect(wrapper.find('.jev-unavailable').exists()).toBe(true)
  })

  // AMENDED (#635): the notice left these rows for the foot of Integrations, where SettingsPanel
  // draws it whatever they show (SettingsPanel.test.ts pins it with storage unavailable); these
  // rows no longer carry a copy of it.
  it('still draws the privacy notice — the section explains itself either way', () => {
    const wrapper = render({ configured: false, unavailableReason: 'encryption-unavailable' })
    expect(wrapper.find('.privacy-notice').exists()).toBe(false)
    expect(mount(JevPrivacyNotice).classes()).toContain('privacy-notice')
  })
})

/*
 * Jev routing profiles: profile and defaults (#509 follow-up) — APPENDED,
 * nothing above changed.
 *
 * Both controls are gated on `configured`, the same way the key controls
 * above already are — Settings shows neither while no key is set.
 */
describe('JevSettings — the routing profile, gated on configured', () => {
  it('draws nothing about the profile, the default launch or delegation while unconfigured', () => {
    const wrapper = render({ configured: false })
    expect(wrapper.find('.jev-profile').exists()).toBe(false)
    expect(wrapper.find('.jev-default-launch').exists()).toBe(false)
    expect(wrapper.find('.jev-delegation').exists()).toBe(false)
  })

  it('offers exactly Economy, Balanced and Premium, in that order', () => {
    const wrapper = render({ configured: true })
    // AMENDED (#635): each chip is its name alone.
    const names = wrapper.findAll('.profile-option').map((node) => node.text())
    expect(names).toEqual(['Economy', 'Balanced', 'Premium'])
  })

  it('marks the stored profile selected, and no other', () => {
    const wrapper = render({
      configured: true,
      preferences: { profile: 'premium', default: {}, delegation: false }
    })
    // AMENDED (#635): radio chips, aria-checked, where it was the is-selected class.
    expect(checkedProfiles(wrapper)).toEqual(['Premium'])
  })

  // AMENDED (#635): the three lines are the row's help now, each after its profile's name, as
  // the design's row prints them (they were one line under each chip).
  it('describes each profile in one line', () => {
    const wrapper = render({ configured: true })
    expect(wrapper.get('.jev-profile .dm-srow__help').text()).toBe(
      'Economy: cheapest model that can do the job. Balanced: cost and capability weighed per prompt. Premium: most capable model when the task warrants it; trivial prompts still go cheap.'
    )
  })

  it('emits the whole preferences document with the new profile, default untouched', async () => {
    const wrapper = render({
      configured: true,
      preferences: { profile: 'balanced', default: { provider: 'claude' }, delegation: false }
    })
    const options = wrapper.findAll('.profile-option')
    await options[2]?.trigger('click')
    expect(wrapper.emitted('preferences-change')).toEqual([
      [{ profile: 'premium', default: { provider: 'claude' }, delegation: false }]
    ])
  })

  it('disables every profile option while a preferences save is in flight', () => {
    const wrapper = render({ configured: true }, { saving: true })
    for (const option of wrapper.findAll('.profile-option')) {
      expect(option.attributes('disabled')).toBeDefined()
    }
  })
})

describe('JevSettings — the default launch, gated on configured', () => {
  const PROVIDERS: AgentProviderOption[] = [
    { provider: 'claude', installed: true, launchable: true },
    { provider: 'codex', installed: true, launchable: true },
    { provider: 'antigravity', installed: false, launchable: false },
    { provider: 'opencode', installed: true, launchable: false, reason: 'not launchable yet' }
  ]
  const CATALOGS: AgentModelCatalog[] = [
    {
      provider: 'claude',
      models: [{ value: 'claude-sonnet-5', label: 'Sonnet' }, { value: 'claude-haiku-4-5' }],
      efforts: ['low', 'high'],
      source: 'provider'
    }
  ]

  // AMENDED (#635): by the name people know each tool by, the design's own words ("Default
  // provider shows Claude"), where it was the product names Claude Code and Codex CLI.
  it('offers only the launchable providers, by product name, plus None', () => {
    const wrapper = render({ configured: true }, { providers: PROVIDERS })
    const options = wrapper
      .find('[aria-label="Default provider"]')
      .findAll('option')
      .map((node) => node.text())
    expect(options).toEqual(['None', 'Claude', 'Codex'])
  })

  it('selects None when no default provider is stored', () => {
    const wrapper = render({ configured: true }, { providers: PROVIDERS })
    const select = wrapper.find('[aria-label="Default provider"]')
    expect((select.element as HTMLSelectElement).value).toBe('')
  })

  it('reflects the stored default provider', () => {
    const wrapper = render(
      {
        configured: true,
        preferences: { profile: 'balanced', default: { provider: 'codex' }, delegation: false }
      },
      { providers: PROVIDERS }
    )
    const select = wrapper.find('[aria-label="Default provider"]')
    expect((select.element as HTMLSelectElement).value).toBe('codex')
  })

  it('disables the model and effort selects until a provider is chosen', () => {
    const wrapper = render({ configured: true }, { providers: PROVIDERS, catalogs: CATALOGS })
    expect(wrapper.find('[aria-label="Default model"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[aria-label="Default effort"]').attributes('disabled')).toBeDefined()
  })

  it("offers the chosen provider's own catalogue, plus CLI default", () => {
    const wrapper = render(
      {
        configured: true,
        preferences: { profile: 'balanced', default: { provider: 'claude' }, delegation: false }
      },
      { providers: PROVIDERS, catalogs: CATALOGS }
    )
    const modelOptions = wrapper
      .find('[aria-label="Default model"]')
      .findAll('option')
      .map((node) => node.text())
    expect(modelOptions).toEqual(['CLI default', 'Sonnet', 'claude-haiku-4-5'])
    const effortOptions = wrapper
      .find('[aria-label="Default effort"]')
      .findAll('option')
      .map((node) => node.text())
    expect(effortOptions).toEqual(['CLI default', 'low', 'high'])
  })

  it('emits a new default provider, clearing model and effort', async () => {
    const wrapper = render(
      {
        configured: true,
        preferences: {
          profile: 'balanced',
          default: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
          delegation: false
        }
      },
      { providers: PROVIDERS, catalogs: CATALOGS }
    )
    const select = wrapper.find('[aria-label="Default provider"]')
    ;(select.element as HTMLSelectElement).value = 'codex'
    await select.trigger('change')
    expect(wrapper.emitted('preferences-change')).toEqual([
      [{ profile: 'balanced', default: { provider: 'codex' }, delegation: false }]
    ])
  })

  it('emits a chosen model, keeping the provider and effort', async () => {
    const wrapper = render(
      {
        configured: true,
        preferences: {
          profile: 'balanced',
          default: { provider: 'claude', effort: 'low' },
          delegation: false
        }
      },
      { providers: PROVIDERS, catalogs: CATALOGS }
    )
    const select = wrapper.find('[aria-label="Default model"]')
    ;(select.element as HTMLSelectElement).value = 'claude-sonnet-5'
    await select.trigger('change')
    expect(wrapper.emitted('preferences-change')).toEqual([
      [
        {
          profile: 'balanced',
          default: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
          delegation: false
        }
      ]
    ])
  })

  it('clears the model back to CLI default', async () => {
    const wrapper = render(
      {
        configured: true,
        preferences: {
          profile: 'balanced',
          default: { provider: 'claude', model: 'claude-sonnet-5' },
          delegation: false
        }
      },
      { providers: PROVIDERS, catalogs: CATALOGS }
    )
    const select = wrapper.find('[aria-label="Default model"]')
    ;(select.element as HTMLSelectElement).value = ''
    await select.trigger('change')
    expect(wrapper.emitted('preferences-change')).toEqual([
      [{ profile: 'balanced', default: { provider: 'claude' }, delegation: false }]
    ])
  })

  it('emits a chosen effort, keeping the provider and model', async () => {
    const wrapper = render(
      {
        configured: true,
        preferences: {
          profile: 'balanced',
          default: { provider: 'claude', model: 'claude-sonnet-5' },
          delegation: false
        }
      },
      { providers: PROVIDERS, catalogs: CATALOGS }
    )
    const select = wrapper.find('[aria-label="Default effort"]')
    ;(select.element as HTMLSelectElement).value = 'high'
    await select.trigger('change')
    expect(wrapper.emitted('preferences-change')).toEqual([
      [
        {
          profile: 'balanced',
          default: { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' },
          delegation: false
        }
      ]
    ])
  })

  it('names what the default is for', () => {
    const wrapper = render({ configured: true }, { providers: PROVIDERS })
    // AMENDED (#635): the row's help line.
    expect(wrapper.find('.jev-default-launch .dm-srow__help').text()).toBe(
      'Used when Jev cannot decide.'
    )
  })

  it('redraws the provider select only from a new settings prop, not from the DOM change alone', async () => {
    // Same rule the key input holds: hand-bound from `settings`, so a change
    // this component only EMITTED — main never confirmed it — leaves the
    // select showing what the prop still says once Vue reconciles it.
    const wrapper = render(
      {
        configured: true,
        preferences: { profile: 'balanced', default: { provider: 'claude' }, delegation: false }
      },
      { providers: PROVIDERS, catalogs: CATALOGS }
    )
    const select = wrapper.find('[aria-label="Default provider"]')
    ;(select.element as HTMLSelectElement).value = 'codex'
    await select.trigger('change')
    // A fresh settings object with the SAME stored value main never changed —
    // if this were local (v-model) state, the DOM edit above would survive it.
    await wrapper.setProps({
      settings: {
        configured: true,
        preferences: { profile: 'balanced', default: { provider: 'claude' }, delegation: false }
      }
    })
    expect((select.element as HTMLSelectElement).value).toBe('claude')
  })

  it('disables every select while a preferences save is in flight', () => {
    const wrapper = render(
      { configured: true },
      { providers: PROVIDERS, catalogs: CATALOGS, saving: true }
    )
    expect(wrapper.find('[aria-label="Default provider"]').attributes('disabled')).toBeDefined()
  })
})

/* --- MCP subtask delegation: the gate preference (#511) — one block, appended --- */
// AMENDED (#635): the checkbox is the design's switch now, in the danger zone row
// "Subagent delegation · beta"; every guarantee below is the checkbox's, on the switch.
describe('JevSettings — the delegation checkbox, gated on configured', () => {
  const toggle = (wrapper: ReturnType<typeof render>) => wrapper.find('.delegation-toggle')

  it('is unchecked by default', () => {
    expect(toggle(render({ configured: true })).attributes('aria-checked')).toBe('false')
  })

  it('reflects a stored delegation of true', () => {
    const wrapper = render({
      configured: true,
      preferences: { profile: 'balanced', default: {}, delegation: true }
    })
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
  })

  // AMENDED (#635): was the checkbox's label, "Let Jev choose subagents by subtask complexity
  // (BETA - CRITICAL WARNING)"; the row names it, warns in the danger zone, and the switch keeps
  // the sentence as its accessible name.
  it('names what the checkbox does', () => {
    const wrapper = render({ configured: true })
    expect(wrapper.get('.jev-delegation .dm-srow__label').text()).toBe('Subagent delegation · beta')
    expect(wrapper.get('.jev-delegation').classes()).toContain('dm-srow--danger')
    expect(toggle(wrapper).attributes('aria-label')).toBe(
      'Let Jev choose subagents by subtask complexity'
    )
  })

  it('emits the whole preferences document with delegation flipped, profile and default untouched', async () => {
    const wrapper = render({
      configured: true,
      preferences: { profile: 'premium', default: { provider: 'claude' }, delegation: false }
    })
    await toggle(wrapper).trigger('click')
    expect(wrapper.emitted('preferences-change')).toEqual([
      [{ profile: 'premium', default: { provider: 'claude' }, delegation: true }]
    ])
  })

  it('disables the checkbox while a preferences save is in flight', () => {
    const wrapper = render({ configured: true }, { saving: true })
    expect(toggle(wrapper).attributes('disabled')).toBeDefined()
  })
})
/* --- end of the #511 block ---------------------------------------------------- */

/*
 * Showing the person why a routing profile did not change (2026-09-21).
 *
 * The section used to answer a refused write by silently drawing the stored
 * profile again, which reads as a control that ignores clicks. The reason
 * existed — main logged it — but only where a terminal could see it.
 */
describe('JevSettings reporting a preference write that did not happen', () => {
  function withError(message: string) {
    return mount(JevSettings, {
      props: {
        settings: {
          configured: true,
          preferences: { profile: 'balanced', default: {}, delegation: false },
          preferencesError: message
        },
        saving: false,
        providers: [],
        catalogs: []
      }
    })
  }

  it('shows the reason beside the control it belongs to', () => {
    const wrapper = withError('That default names a provider this build cannot launch.')
    const notice = wrapper.get('.preferences-error')
    expect(notice.text()).toContain('cannot launch')
  })

  it('announces it, since the control it explains looks unchanged', () => {
    // Nothing else on screen moved, so a sighted user has the sentence and a
    // screen-reader user would otherwise have nothing at all.
    expect(withError('nope').get('.preferences-error').attributes('role')).toBe('alert')
  })

  it('says nothing at all when the last write went through', () => {
    const wrapper = mount(JevSettings, {
      props: {
        settings: {
          configured: true,
          preferences: { profile: 'balanced', default: {}, delegation: false }
        },
        saving: false,
        providers: [],
        catalogs: []
      }
    })
    expect(wrapper.find('.preferences-error').exists()).toBe(false)
  })

  it('keeps drawing the profile actually in force beside the reason', () => {
    // The honesty rule: the mark follows what is STORED, never what was
    // asked for. A failed click must not leave the panel claiming a profile
    // nothing is routing under.
    // AMENDED (#635): read through aria-checked on the radio chips.
    const wrapper = withError('nope')
    const selected = wrapper
      .findAll('.profile-option')
      .filter((option) => option.attributes('aria-checked') === 'true')
      .map((option) => option.text())
    expect(selected).toEqual(['Balanced'])
  })
})
