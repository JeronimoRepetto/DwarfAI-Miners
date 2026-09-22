// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { motion } from 'motion-v'
import { pressHoverVariants } from '../../lib/shell/presence'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../types'
import {
  DEFAULT_AUDIO_PREFERENCES,
  DEFAULT_NOTIFICATIONS_ENABLED,
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  DEFAULT_JEV_PREFERENCES
  /* --- end of the #509 follow-up block --------------------------------------- */
} from '../../types'
import PanelTransition from '../shell/PanelTransition.vue'
import SettingsPanel from './SettingsPanel.vue'

/**
 * The redesigned Settings screen's container (#138, screens/settings.md):
 * the panel's own "Settings" title and divider, then every section in the
 * design's order — Panel shortcut, Position, Data Base — plus the
 * "Application" section the design itself does not draw (pin, hide panel,
 * version — #142 parked them with no design home; #138 gives them this
 * design's control styling and this explicit UNSPECIFIED placement).
 *
 * SettingsPanel stays presentational like every other settings piece: every
 * verdict arrives as a prop and every intent leaves as an event, so App.vue
 * keeps owning the IPC. The reset modal's OPEN/CLOSED state is the one
 * exception, kept local here — it is pure display state with nothing outside
 * this screen that ever needs to know it.
 */
function shortcutState(overrides: Partial<ShortcutState> = {}): ShortcutState {
  return {
    accelerator: DEFAULT_TOGGLE_ACCELERATOR,
    registered: true,
    platform: 'win32',
    ...overrides
  }
}

function render(props: Record<string, unknown> = {}) {
  return mount(SettingsPanel, {
    props: {
      shortcutState: shortcutState(),
      shortcutError: null,
      shortcutRecording: false,
      shortcutApplying: false,
      edge: 'right',
      edgeApplying: false,
      pinned: true,
      pinTooltip: 'Pinned: the panel stays above other windows',
      versionText: '1.2.3',
      versionHint: 'Packaged build',
      resetting: false,
      resetError: null,
      audioSettings: { ...DEFAULT_AUDIO_PREFERENCES },
      // AMENDED for #316: one required prop added, the notifications switch.
      // No existing prop or assertion changed.
      notificationsEnabled: DEFAULT_NOTIFICATIONS_ENABLED,
      // AMENDED for #370: two more, the stored faces and whether a change is in
      // flight. No existing prop or assertion changed.
      typography: { ...DEFAULT_TYPOGRAPHY_PREFERENCES },
      typographyApplying: false,
      // AMENDED for #509: two more required props, the Jev API-key verdict and
      // whether a save/clear is in flight. No existing prop or assertion
      // changed.
      jevSettings: { configured: false, preferences: DEFAULT_JEV_PREFERENCES },
      jevSaving: false,
      // AMENDED for the #509 follow-up: two more required props, the
      // launchable providers and model catalogues the default-launch pickers
      // draw from. No existing prop or assertion changed.
      jevProviders: [],
      jevCatalogs: [],
      ...props
    }
  })
}

describe('SettingsPanel — frame', () => {
  it('draws the design’s own title and divider', () => {
    const wrapper = render()
    expect(wrapper.find('.settings-title').text()).toBe('Settings')
    expect(wrapper.find('.settings-divider').exists()).toBe(true)
  })
})

describe('SettingsPanel — sections in the design’s order', () => {
  it('mounts the Panel shortcut section with the state it was given', () => {
    const wrapper = render({
      shortcutState: shortcutState({ accelerator: 'Control+Alt+M' })
    })
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + M')
  })

  it('mounts the Position section on the given edge', () => {
    const wrapper = render({ edge: 'left' })
    expect(wrapper.find('.position-left').attributes('aria-pressed')).toBe('true')
  })

  it('mounts the Data Base section', () => {
    expect(render().find('.reset-metrics').text()).toBe('Reset metrics')
  })

  /*
   * The Audio section (#174), a maintainer-specified extension of
   * `screens/settings.md`. It sits between Position and Data Base — after the
   * two sections the design draws, before the destructive one that #138's own
   * comment already carries to the bottom of the panel. #316 adds a
   * notifications switch beside it, and the same gap is where that lands.
   */
  it('mounts the Audio section with the settings it was given', () => {
    const wrapper = render({
      audioSettings: { ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 0.4 }
    })
    expect((wrapper.find('.music-volume').element as HTMLInputElement).value).toBe('0.4')
  })

  it('draws Audio after Position and before Data Base', () => {
    const sections = render()
      .findAll('section')
      .map((section) => section.classes()[0])
    expect(sections.indexOf('audio-settings')).toBeGreaterThan(
      sections.indexOf('position-settings')
    )
    expect(sections.indexOf('audio-settings')).toBeLessThan(sections.indexOf('data-base-settings'))
  })

  /*
   * APPENDED for #316. The Notifications section is the second extension of
   * `screens/settings.md` and lands in the same gap Audio opened — the source
   * file itself already names it as joining that gap.
   */
  it('mounts the Notifications section in the state it was given', () => {
    expect(
      render({ notificationsEnabled: false })
        .find('.notifications-enabled')
        .attributes('aria-pressed')
    ).toBe('false')
  })

  it('draws Notifications after Audio and before Data Base', () => {
    const sections = render()
      .findAll('section')
      .map((section) => section.classes()[0])
    expect(sections.indexOf('notification-settings')).toBeGreaterThan(
      sections.indexOf('audio-settings')
    )
    expect(sections.indexOf('notification-settings')).toBeLessThan(
      sections.indexOf('data-base-settings')
    )
  })

  /*
   * APPENDED for #370. Unlike Audio and Notifications, this extension has a
   * home the design source states outright — "after Position and before Audio"
   * — so its place is transcribed rather than decided.
   */
  it('mounts the Typography section with the faces it was given', () => {
    const wrapper = render({
      typography: { interfaceFont: 'roboto', messagingFont: 'arial' }
    })
    expect(wrapper.find('.interface-font[data-font="roboto"]').attributes('aria-pressed')).toBe(
      'true'
    )
    expect(wrapper.find('.messaging-font[data-font="arial"]').attributes('aria-pressed')).toBe(
      'true'
    )
  })

  it('draws Typography after Position and before Audio', () => {
    const sections = render()
      .findAll('section')
      .map((section) => section.classes()[0])
    expect(sections.indexOf('typography-settings')).toBeGreaterThan(
      sections.indexOf('position-settings')
    )
    expect(sections.indexOf('typography-settings')).toBeLessThan(sections.indexOf('audio-settings'))
  })

  it('locks the Typography segments while a change is in flight', () => {
    const wrapper = render({ typographyApplying: true })
    expect(wrapper.find('.interface-font[data-font="roboto"]').attributes('disabled')).toBeDefined()
  })

  /*
   * APPENDED for #509. Jev's Settings section is a maintainer-specified
   * extension of `screens/settings.md`, like Audio and Notifications before
   * it — composed after Notifications and before Data Base, per the task.
   */
  it('mounts the Jev section with the settings it was given', () => {
    const wrapper = render({ jevSettings: { configured: true } })
    expect(wrapper.find('.jev-configured').exists()).toBe(true)
  })

  it('draws Jev after Notifications and before Data Base', () => {
    const sections = render()
      .findAll('section')
      .map((section) => section.classes()[0])
    expect(sections.indexOf('jev-settings')).toBeGreaterThan(
      sections.indexOf('notification-settings')
    )
    expect(sections.indexOf('jev-settings')).toBeLessThan(sections.indexOf('data-base-settings'))
  })

  // APPENDED for the #509 follow-up.
  it('passes the launchable providers through to the default-launch picker', () => {
    const wrapper = render({
      jevSettings: { configured: true, preferences: DEFAULT_JEV_PREFERENCES },
      jevProviders: [{ provider: 'claude', installed: true, launchable: true }]
    })
    const options = wrapper
      .find('[aria-label="Default provider"]')
      .findAll('option')
      .map((node) => node.text())
    expect(options).toEqual(['None', 'Claude Code'])
  })
})

describe('SettingsPanel — forwarding intents up (App owns the IPC)', () => {
  it('forwards the shortcut recorder’s events untouched', async () => {
    const wrapper = render()
    await wrapper.find('.recorder').trigger('click')
    expect(wrapper.emitted('start-recording')).toHaveLength(1)
  })

  it('forwards a position choice as select-edge', async () => {
    const wrapper = render({ edge: 'right' })
    await wrapper.find('.position-left').trigger('click')
    expect(wrapper.emitted('select-edge')).toEqual([['left']])
  })

  it('forwards the pin toggle', async () => {
    const wrapper = render()
    await wrapper.find('.pin').trigger('click')
    expect(wrapper.emitted('toggle-pin')).toHaveLength(1)
  })

  it('forwards hide panel', async () => {
    const wrapper = render()
    await wrapper.find('.hide-panel').trigger('click')
    expect(wrapper.emitted('hide-panel')).toHaveLength(1)
  })

  it('forwards an Audio change as audio-change, carrying only the field that moved', async () => {
    const wrapper = render()
    await wrapper.find('.music-at-startup').trigger('click')
    expect(wrapper.emitted('audio-change')).toEqual([[{ musicAtStartup: false }]])
  })

  // APPENDED for #316.
  it('forwards the notifications switch as notifications-change', async () => {
    const wrapper = render({ notificationsEnabled: true })
    await wrapper.find('.notifications-enabled').trigger('click')
    expect(wrapper.emitted('notifications-change')).toEqual([[false]])
  })

  // APPENDED for #370.
  it('forwards a Typography choice as typography-change, carrying only the role that moved', async () => {
    const wrapper = render()
    await wrapper.find('.messaging-font[data-font="roboto"]').trigger('click')
    expect(wrapper.emitted('typography-change')).toEqual([[{ messagingFont: 'roboto' }]])
  })

  // APPENDED for #509.
  it('forwards a Jev save as jev-save, carrying the typed key', async () => {
    const wrapper = render()
    const input = wrapper.find('.jev-key-input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    await wrapper.find('.jev-save').trigger('click')
    expect(wrapper.emitted('jev-save')).toEqual([['sk-typesafe-abc123']])
  })

  it('forwards a Jev clear as jev-clear', async () => {
    const wrapper = render({ jevSettings: { configured: true } })
    await wrapper.find('.jev-clear').trigger('click')
    expect(wrapper.emitted('jev-clear')).toHaveLength(1)
  })

  // APPENDED for the #509 follow-up.
  it('forwards a routing profile choice as jev-preferences-change, carrying the whole document', async () => {
    const wrapper = render({
      jevSettings: { configured: true, preferences: DEFAULT_JEV_PREFERENCES }
    })
    const options = wrapper.findAll('.profile-option')
    await options[2]?.trigger('click')
    expect(wrapper.emitted('jev-preferences-change')).toEqual([
      [{ profile: 'premium', default: {}, delegation: false }]
    ])
  })
})

describe('SettingsPanel — the Application section (#142 relocations, #138 restyled)', () => {
  it('draws the pin, hide panel and version controls', () => {
    const wrapper = render()
    expect(wrapper.find('.pin').exists()).toBe(true)
    expect(wrapper.find('.hide-panel').exists()).toBe(true)
    expect(wrapper.find('.version').text()).toBe('1.2.3')
  })

  it('renders no version element when none was given, rather than a placeholder', () => {
    const wrapper = render({ versionText: null })
    expect(wrapper.find('.version').exists()).toBe(false)
  })
})

describe('SettingsPanel — the reset-metrics modal', () => {
  it('mounts the reset modal through the shared vertical panel transition', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')

    const transition = wrapper.findComponent(PanelTransition)
    expect(transition.exists()).toBe(true)
    expect(transition.props('axis')).toBe('vertical')
  })

  it('starts closed', () => {
    expect(render().find('.reset-modal').exists()).toBe(false)
  })

  it('opens from the Data Base section', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')
    expect(wrapper.find('.modal-title').text()).toBe('Reset metrics')
  })

  it('closes from its own close control', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')
    await wrapper.find('.modal-close').trigger('click')
    expect(wrapper.find('.reset-modal').exists()).toBe(false)
  })

  it('forwards a confirmed reset as reset-confirm', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')
    await wrapper.find('.modal-input').setValue('yes')
    await wrapper.find('.modal-confirm').trigger('click')
    expect(wrapper.emitted('reset-confirm')).toHaveLength(1)
  })

  it('passes resetting and resetError through to the modal', async () => {
    const wrapper = render({ resetting: true, resetError: 'Nothing was deleted.' })
    await wrapper.find('.reset-metrics').trigger('click')
    expect(wrapper.find('.modal-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[role="alert"]').text()).toBe('Nothing was deleted.')
  })
})

/*
 * Grouping the sections (maintainer request, 2026-09-21).
 *
 * Settings grew from the design's three sections to eight — Panel shortcut,
 * Position, Typography, Audio, Notifications, Jev, Data Base, Application —
 * each drawing its own heading, all in one column with nothing between them.
 * `settings.md` says so itself twice over: "previously listed three sections
 * and now lists four", then five. Eight headings in a row is not a list any
 * more, it is a wall, and the maintainer's word for it was that the panel is
 * hard to read.
 *
 * So a rule between GROUPS, not between every section. The first group is the
 * two the design source already names together — `Panel shortcut` and `Panel
 * position` share that prefix in `screens/settings.md` — and the bottom
 * cluster keeps Data Base with Application, which DataBaseSection's own
 * comment already treats as one.
 *
 * Asserted as a SEQUENCE rather than a count: a separator in the wrong place
 * groups the wrong things, and a count would pass for any arrangement.
 */
describe('SettingsPanel section grouping', () => {
  /** The panel's children in render order, as either a heading or a rule. */
  function layout(wrapper: ReturnType<typeof render>): string[] {
    const panel = wrapper.get('.settings-panel').element
    const read: string[] = []
    for (const child of Array.from(panel.children)) {
      if (child.classList.contains('settings-head')) {
        read.push('title')
        continue
      }
      if (child.classList.contains('group-divider')) {
        read.push('---')
        continue
      }
      // A section identifies itself by the heading it already draws; the
      // grouping adds no second label, which would say every name twice.
      const heading = child.querySelector('.field-label, .section-label')
      if (heading?.textContent) read.push(heading.textContent.trim())
    }
    return read
  }

  it('rules between groups, leaving the two Panel sections together', () => {
    expect(layout(render())).toEqual([
      'title',
      'Panel shortcut',
      'Position',
      '---',
      'Typography',
      '---',
      'Audio',
      '---',
      'Notifications',
      '---',
      'Jev',
      '---',
      'Data Base',
      'Application'
    ])
  })

  it('draws no rule directly under the title, which has its own', () => {
    // `.settings-head` already ends in `.settings-divider`. A group rule
    // immediately after it would read as a double line under the heading.
    const order = layout(render())
    expect(order[0]).toBe('title')
    expect(order[1]).not.toBe('---')
  })

  it('never ends on a rule, which would underline the panel', () => {
    const order = layout(render())
    expect(order[order.length - 1]).not.toBe('---')
  })

  it('marks every group rule presentational, since it names nothing', () => {
    const wrapper = render()
    const rules = wrapper.findAll('.group-divider')
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(rule.attributes('role')).toBe('presentation')
  })
})

/*
 * ADDED for #566 T4: the panel's own two controls answer a pointer through the
 * shared vocabulary.
 *
 * Its OWN two, and that boundary is asserted: the settings groups above them
 * are their own components (audio, notifications, Jev, database, shortcut,
 * typography, position), and giving their controls the same feedback is a
 * separate change against the files that own them.
 */
describe('SettingsPanel press and hover feedback', () => {
  it('routes both application controls through motion.button carrying the shared variants', () => {
    const controls = render().findAllComponents(motion.button)

    expect(controls.map((control) => control.classes()[0])).toEqual(['pin', 'hide-panel'])
    for (const control of controls) {
      expect(control.props('whileHover')).toEqual(pressHoverVariants.whileHover)
      expect(control.props('whilePress')).toEqual(pressHoverVariants.whilePress)
    }
  })

  it('leaves both buttons with the name, pressed state, hint and press they had', async () => {
    const wrapper = render({
      pinned: true,
      pinTooltip: 'Pinned: the panel stays above other windows'
    })

    const pin = wrapper.get('.pin')
    expect(pin.element.tagName).toBe('BUTTON')
    expect(pin.attributes('type')).toBe('button')
    expect(pin.attributes('aria-label')).toBe('Keep panel on top')
    expect(pin.attributes('aria-pressed')).toBe('true')
    expect(pin.attributes('title')).toBe('Pinned: the panel stays above other windows')
    await pin.trigger('click')
    expect(wrapper.emitted('toggle-pin')).toHaveLength(1)

    const hide = wrapper.get('.hide-panel')
    expect(hide.element.tagName).toBe('BUTTON')
    expect(hide.attributes('title')).toBe('Hide the panel; the shortcut or the tray brings it back')
    await hide.trigger('click')
    expect(wrapper.emitted('hide-panel')).toHaveLength(1)
  })
})
