// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { KEYBOARD_MAPS, type KeyMapRow } from './keyboardMaps'
import MenuList from '../components/overlay/MenuList.vue'
import ModalDialog from '../components/overlay/ModalDialog.vue'
import InputField from '../components/controls/InputField.vue'
import MessageComposer from '../components/message/MessageComposer.vue'
import DwarfMessagePanel from '../components/message/DwarfMessagePanel.vue'
import DwarfQuestionCard from '../components/dwarf/DwarfQuestionCard.vue'
import AddPanel from '../components/launch/AddPanel.vue'
import HistoryPanel from '../components/history/HistoryPanel.vue'
import SettingsPanel from '../components/panel/SettingsPanel.vue'
import TypographySettings from '../components/panel/TypographySettings.vue'
import { OTHER_CHOICE } from '../lib/launch/launchState'
import { providerChips } from '../lib/launch/providerChips'
import { defaultDwarf, defaultMine } from '../testing/factories'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import {
  DEFAULT_AUDIO_PREFERENCES,
  DEFAULT_JEV_PREFERENCES,
  DEFAULT_NOTIFICATIONS_ENABLED,
  DEFAULT_OPENCODE_SETTINGS,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  type DwarfQuestion,
  type MineHistorySpeaker
} from '../types'

/*
 * L12 unit (ISSUE-266; 17 §1.12): the Panel's keyboard maps as a table, one row per key per surface (NFR-A11Y-06),
 * each key pressed where its row says, checked against what its row says it does. The rows are the design's
 * accessibility tables ("Keyboard: everywhere", "Keyboard: Panel"); Veta's and Valle's maps are their epics'.
 *
 * jsdom performs no default action for a key, so `press` does what a browser does after an unprevented keydown on a
 * button: Enter clicks it. A handler that takes the key itself prevents that, as it must in a browser too.
 */

const ROOT = join(__dirname, '..', '..', '..', '..')

/** The keys the design's two tables hold, one entry per key per place (accessibility.md, Keyboard). */
const DESIGN_ROWS = [
  'everywhere/any-mode/Control+Alt+Shift+P',
  'everywhere/any-layer/Escape',
  'everywhere/search-field/Escape',
  'everywhere/menus/ArrowUp',
  'everywhere/menus/ArrowDown',
  'everywhere/menus/Home',
  'everywhere/menus/End',
  'everywhere/menus/Enter',
  'everywhere/menus/Tab',
  'everywhere/dialogs/Tab',
  'everywhere/dialogs/Shift+Tab',
  'everywhere/typed-confirmation/Enter',
  'everywhere/composer/Enter',
  'everywhere/composer/Shift+Enter',
  'everywhere/message-panel-name/Enter',
  'everywhere/message-panel-name/F2',
  'everywhere/message-panel-name-field/Enter',
  'everywhere/message-panel-name-field/Escape',
  'everywhere/question-card/1-9',
  'everywhere/question-card/Enter',
  'everywhere/add-panel-prompt/Control+Enter',
  'everywhere/history-tabs/ArrowLeft',
  'everywhere/history-tabs/ArrowRight',
  'panel/nav-page-mine-column/Tab',
  'panel/settings-sections/ArrowUp',
  'panel/settings-sections/ArrowDown',
  'panel/font-style/ArrowLeft',
  'panel/font-style/ArrowRight',
  'panel/font-style/ArrowUp',
  'panel/font-style/ArrowDown'
]

let mounted: VueWrapper[] = []

/** Mounts into the document, so focus and document-level listeners behave as in the window. */
function attach<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

/** A keydown as the keyboard sends it, plus the browser's own default action on a button. */
async function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {}
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  if (!event.defaultPrevented && key === 'Enter' && target instanceof HTMLButtonElement)
    target.click()
  await flushPromises()
  return event
}

const active = (): Element | null => document.activeElement

// --- The surfaces the rows are pressed on ---------------------------------------------------------------------

const MENU = [
  { label: 'Open history' },
  { label: 'Reset name', disabled: true, title: 'Reset name · no custom name' },
  { label: 'Open console' },
  { separator: true as const },
  { label: 'Stop dwarf…', danger: true }
]

function menu() {
  return attach(mount(MenuList, { props: { items: MENU }, attachTo: document.body }))
}

const menuItem = (wrapper: VueWrapper, index: number): HTMLElement =>
  wrapper.get(`[data-index="${index}"]`).element as HTMLElement

/** A dialog opened from a button, as every dialog of the Panel is. */
function dialog(props: Record<string, unknown> = {}) {
  const Host = defineComponent({
    setup() {
      const open = ref(false)
      const events = ref<string[]>([])
      return () => [
        h('button', { class: 'opener', onClick: () => (open.value = true) }, 'Open'),
        h(
          ModalDialog,
          {
            open: open.value,
            title: 'Remove mine?',
            actions: [{ label: 'Cancel' }, { label: 'Remove', variant: 'danger', confirms: true }],
            ...props,
            onCancel: () => {
              events.value.push('cancel')
              open.value = false
            },
            onAction: (index: number) => events.value.push('action:' + index)
          },
          () => h('p', 'It goes from the list.')
        )
      ]
    }
  })
  return attach(mount(Host, { attachTo: document.body }))
}

async function openDialog(props: Record<string, unknown> = {}) {
  const wrapper = dialog(props)
  const opener = wrapper.get('.opener').element as HTMLButtonElement
  opener.focus()
  opener.click()
  await flushPromises()
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.dm-dialog__actions button')]
  return { wrapper, opener, buttons }
}

function composer() {
  return attach(
    mount(MessageComposer, {
      props: { value: 'dig here', placeholder: 'Write to Durin…', hint: '', canSend: true },
      attachTo: document.body
    })
  )
}

const BASE_NAME = 'dwarfai-55'

function messagePanel() {
  const api = {
    setDwarfName: vi.fn(async ({ name }: { name: string }) => ({ saved: true, customName: name })),
    resetDwarfNameToday: vi.fn().mockResolvedValue({ saved: true })
  }
  // The generated fake refuses any member the channel registry lacks (ADR-033 item 7).
  ;(window as unknown as { api: unknown }).api = createFakeWindowApi(
    api as unknown as Partial<Window['api']>
  )
  const wrapper = attach(
    mount(DwarfMessagePanel, {
      props: {
        dwarf: defaultDwarf({ id: 'd55', name: BASE_NAME, textDelivery: 'terminal' }),
        feed: { readable: true, messages: [], source: 'held' }
      },
      attachTo: document.body
    })
  )
  return { wrapper, api }
}

const nameField = (wrapper: VueWrapper): HTMLInputElement | null =>
  wrapper.find('.dm-msg__field input').exists()
    ? (wrapper.get('.dm-msg__field input').element as HTMLInputElement)
    : null

function question(steps: number): DwarfQuestion {
  const one = {
    question: 'Which database?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'Neither' }]
  }
  return {
    toolUseId: 'toolu_01',
    channel: 'held',
    questions:
      steps === 1
        ? [one]
        : [one, { question: 'Which region?', multiSelect: false, options: [{ label: 'East' }] }]
  }
}

function questionCard(steps = 1) {
  return attach(
    mount(DwarfQuestionCard, {
      props: { question: question(steps), name: 'Durin' },
      attachTo: document.body
    })
  )
}

const questionOptions = (wrapper: VueWrapper) => wrapper.findAll('.dm-qopt:not(.dm-qopt--other)')

function addPanel() {
  return attach(
    mount(AddPanel, {
      props: {
        mineName: 'anvil',
        chips: providerChips(
          [{ provider: 'claude', installed: true, launchable: true }],
          OTHER_CHOICE
        ),
        phase: 'other-command-required',
        enabled: false,
        command: 'my-agent --yes',
        prompt: 'dig',
        refusal: null,
        error: null,
        modelPicker: { visible: false, models: [], disabled: true, note: null },
        effortPicker: { visible: false, efforts: [] },
        permissionsVisible: false,
        jev: {
          availability: 'hidden',
          enabled: false,
          autoAccept: false,
          routing: { phase: 'idle' },
          previousChoice: null,
          launchedOnFallback: false
        }
      },
      attachTo: document.body
    })
  )
}

function speaker(id: string, name: string, at: number): MineHistorySpeaker {
  return {
    id,
    provider: 'claude',
    role: 'worker',
    name,
    lastMessageAt: at,
    messages: [{ role: 'assistant', text: name + ' spoke.', timestamp: new Date(at).toISOString() }]
  }
}

function historyPanel() {
  return attach(
    mount(HistoryPanel, {
      props: {
        mine: defaultMine({ name: 'anvil' }),
        history: {
          readable: true,
          speakers: [speaker('claude:s1', 'Foreman', 1), speaker('claude:s2', 'Scout', 2)]
        }
      },
      attachTo: document.body
    })
  )
}

const historyTabs = (wrapper: VueWrapper) => wrapper.findAll('.dm-hist__tab')
const selectedTab = (wrapper: VueWrapper): string =>
  wrapper.get('.dm-hist__tab[aria-selected="true"] .dm-hist__name').text()

function settingsPanel() {
  return attach(
    mount(SettingsPanel, {
      props: {
        shortcutState: { accelerator: 'Control+Alt+Shift+P', registered: true, platform: 'win32' },
        shortcutError: null,
        shortcutRecording: false,
        shortcutApplying: false,
        edge: 'right',
        edgeApplying: false,
        pinned: true,
        pinTooltip: 'Pinned',
        versionText: '1.2.3',
        versionHint: 'Packaged build',
        resetting: false,
        resetError: null,
        audioSettings: { ...DEFAULT_AUDIO_PREFERENCES },
        notificationsEnabled: DEFAULT_NOTIFICATIONS_ENABLED,
        typography: { ...DEFAULT_TYPOGRAPHY_PREFERENCES },
        typographyApplying: false,
        jevSettings: { configured: false, preferences: DEFAULT_JEV_PREFERENCES },
        jevSaving: false,
        jevProviders: [],
        jevCatalogs: [],
        openCodeSettings: { ...DEFAULT_OPENCODE_SETTINGS },
        openCodeApplying: false
      } as never,
      attachTo: document.body
    })
  )
}

const settingsSection = (wrapper: VueWrapper): string =>
  wrapper.get('[role="tab"][aria-selected="true"]').text()

function fontStyle() {
  return attach(
    mount(TypographySettings, {
      props: { preferences: { ...DEFAULT_TYPOGRAPHY_PREFERENCES }, applying: false },
      attachTo: document.body
    })
  )
}

/** The style a key on the Font style radiogroup asks for, from the default (DwarfAI). */
async function fontStyleAfter(
  key: string
): Promise<{ asked: string; focused: string | undefined }> {
  const wrapper = fontStyle()
  const checked = wrapper.get('[role="radio"][aria-checked="true"]').element as HTMLElement
  checked.focus()
  await press(checked, key)
  const asked =
    (wrapper.emitted('change')?.[0]?.[0] as { style: string } | undefined)?.style ?? 'none'
  return { asked, focused: (active() as HTMLElement | null)?.dataset['id'] }
}

const FONT_STYLES = ['dwarfai', 'pixel-clean', 'readable', 'custom']

// --- What each row does, pressed ------------------------------------------------------------------------------

const DRIVERS: Record<string, () => Promise<void>> = {
  'everywhere/any-mode/Control+Alt+Shift+P': async () => {
    // Heard by Electron main as a global shortcut; the default it registers is this chord.
    const row = rowOf('everywhere/any-mode/Control+Alt+Shift+P')
    if (row.proof.lane === 'jsdom') throw new Error('a global shortcut is not the renderer’s')
    expect(existsSync(join(ROOT, row.proof.proof))).toBe(true)
    expect(readFileSync(join(ROOT, row.proof.proof), 'utf8')).toContain("'Control+Alt+Shift+P'")
  },
  'everywhere/any-layer/Escape': async () => {
    const { opener, wrapper } = await openDialog()
    await press(active()!, 'Escape')
    expect(document.querySelector('.dm-dialog')).toBeNull()
    expect(active()).toBe(opener)
    expect(wrapper.findComponent(ModalDialog).emitted('cancel') ?? []).toHaveLength(1)
  },
  'everywhere/search-field/Escape': async () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    const field = attach(
      mount(InputField, { props: { search: true, value: 'cop' }, attachTo: document.body })
    )
    const input = field.get('input').element as HTMLInputElement
    input.focus()
    await press(input, 'Escape')
    expect(field.emitted('update:value')).toEqual([['']])
    // The first Esc cleared the text and went no further: no layer above it heard it.
    expect(outer).not.toHaveBeenCalled()
    document.removeEventListener('keydown', outer)
  },
  'everywhere/menus/ArrowUp': async () => {
    const wrapper = menu()
    menuItem(wrapper, 0).focus()
    await press(active()!, 'ArrowUp')
    // Wraps from the first to the last enabled item, the danger one below its rule.
    expect(active()).toBe(menuItem(wrapper, 4))
  },
  'everywhere/menus/ArrowDown': async () => {
    const wrapper = menu()
    menuItem(wrapper, 0).focus()
    await press(active()!, 'ArrowDown')
    // Skips the disabled item.
    expect(active()).toBe(menuItem(wrapper, 2))
  },
  'everywhere/menus/Home': async () => {
    const wrapper = menu()
    menuItem(wrapper, 4).focus()
    await press(active()!, 'Home')
    expect(active()).toBe(menuItem(wrapper, 0))
  },
  'everywhere/menus/End': async () => {
    const wrapper = menu()
    menuItem(wrapper, 0).focus()
    await press(active()!, 'End')
    expect(active()).toBe(menuItem(wrapper, 4))
  },
  'everywhere/menus/Enter': async () => {
    const wrapper = menu()
    menuItem(wrapper, 2).focus()
    await press(active()!, 'Enter')
    expect(wrapper.emitted('pick')).toEqual([[2]])
  },
  'everywhere/menus/Tab': async () => {
    const wrapper = menu()
    menuItem(wrapper, 0).focus()
    await press(active()!, 'Tab')
    expect(wrapper.emitted('close') ?? []).toHaveLength(1)
  },
  'everywhere/dialogs/Tab': async () => {
    const { buttons } = await openDialog()
    expect(active()).toBe(buttons[0])
    await press(active()!, 'Tab')
    expect(active()).toBe(buttons[1])
    await press(active()!, 'Tab')
    // Wraps inside the dialog: the focus never leaves it.
    expect(active()).toBe(buttons[0])
  },
  'everywhere/dialogs/Shift+Tab': async () => {
    const { buttons } = await openDialog()
    await press(active()!, 'Tab', { shiftKey: true })
    expect(active()).toBe(buttons[1])
    await press(active()!, 'Tab', { shiftKey: true })
    expect(active()).toBe(buttons[0])
  },
  'everywhere/typed-confirmation/Enter': async () => {
    const { wrapper } = await openDialog({ typed: 'yes' })
    const input = document.querySelector<HTMLInputElement>('.dm-dialog__typed input')!
    input.focus()
    await press(input, 'Enter')
    // Not yet: the field does not hold the word.
    expect(wrapper.findComponent(ModalDialog).emitted('action')).toBeUndefined()
    input.value = 'yes'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    await press(input, 'Enter')
    expect(wrapper.findComponent(ModalDialog).emitted('action')).toEqual([[1]])
  },
  'everywhere/composer/Enter': async () => {
    const wrapper = composer()
    const field = wrapper.get('textarea').element
    const event = await press(field, 'Enter')
    expect(wrapper.emitted('submit') ?? []).toHaveLength(1)
    expect(event.defaultPrevented).toBe(true)
  },
  'everywhere/composer/Shift+Enter': async () => {
    const wrapper = composer()
    const event = await press(wrapper.get('textarea').element, 'Enter', { shiftKey: true })
    // Not sent, and not prevented: the field takes its new line.
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(event.defaultPrevented).toBe(false)
  },
  'everywhere/message-panel-name/Enter': async () => {
    const { wrapper } = messagePanel()
    await press(wrapper.get('.dm-msg__rename').element, 'Enter')
    const field = nameField(wrapper)
    expect(field?.value).toBe(BASE_NAME)
    expect(active()).toBe(field)
    expect([field?.selectionStart, field?.selectionEnd]).toEqual([0, BASE_NAME.length])
  },
  'everywhere/message-panel-name/F2': async () => {
    const { wrapper } = messagePanel()
    await press(wrapper.get('.dm-msg__rename').element, 'F2')
    expect(nameField(wrapper)?.value).toBe(BASE_NAME)
  },
  'everywhere/message-panel-name-field/Enter': async () => {
    const { wrapper, api } = messagePanel()
    await press(wrapper.get('.dm-msg__rename').element, 'F2')
    const field = nameField(wrapper)!
    field.value = 'Watcher'
    field.dispatchEvent(new Event('input'))
    await flushPromises()
    await press(field, 'Enter')
    expect(api.setDwarfName).toHaveBeenCalledWith({ dwarfId: 'd55', name: 'Watcher' })
    expect(nameField(wrapper)).toBeNull()
    expect(active()).toBe(wrapper.get('.dm-msg__rename').element)
  },
  'everywhere/message-panel-name-field/Escape': async () => {
    const { wrapper, api } = messagePanel()
    await press(wrapper.get('.dm-msg__rename').element, 'F2')
    const field = nameField(wrapper)!
    field.value = 'Warden'
    field.dispatchEvent(new Event('input'))
    await flushPromises()
    await press(field, 'Escape')
    // Cancelled, and the panel stays open: only the next Esc closes it.
    expect(api.setDwarfName).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(active()).toBe(wrapper.get('.dm-msg__rename').element)
    await press(active()!, 'Escape')
    expect(wrapper.emitted('close') ?? []).toHaveLength(1)
  },
  'everywhere/question-card/1-9': async () => {
    const wrapper = questionCard()
    const checked = () => questionOptions(wrapper).map((row) => row.attributes('aria-checked'))
    await press(questionOptions(wrapper)[0]!.element, '2')
    expect(checked()).toEqual(['false', 'true', 'false'])
    await press(questionOptions(wrapper)[0]!.element, '3')
    expect(checked()).toEqual(['false', 'false', 'true'])
    // "Other thing…" is the last number; picking never sends.
    await press(questionOptions(wrapper)[0]!.element, '4')
    expect(wrapper.get('.dm-qopt--other').attributes('aria-checked')).toBe('true')
    expect(wrapper.emitted('answer')).toBeUndefined()
  },
  'everywhere/question-card/Enter': async () => {
    const wrapper = questionCard(2)
    await press(questionOptions(wrapper)[0]!.element, '1')
    await press(questionOptions(wrapper)[0]!.element, 'Enter')
    // Answered: Enter goes to the next step, and still sends nothing.
    expect(wrapper.get('.dm-qcard__step').text()).toBe('2 / 2')
    expect(wrapper.emitted('answer')).toBeUndefined()
  },
  'everywhere/add-panel-prompt/Control+Enter': async () => {
    for (const chord of [{ ctrlKey: true }, { metaKey: true }]) {
      const wrapper = addPanel()
      await press(wrapper.get('.dm-add__prompt textarea').element, 'Enter', chord)
      expect(wrapper.emitted('submit') ?? [], JSON.stringify(chord)).toHaveLength(1)
    }
  },
  'everywhere/history-tabs/ArrowLeft': async () => {
    const wrapper = historyPanel()
    const first = selectedTab(wrapper)
    await press(historyTabs(wrapper)[0]!.element, 'ArrowLeft')
    // Wraps from the first tab to the last, and the focus follows.
    expect(selectedTab(wrapper)).not.toBe(first)
    expect(active()).toBe(historyTabs(wrapper).at(-1)!.element)
  },
  'everywhere/history-tabs/ArrowRight': async () => {
    const wrapper = historyPanel()
    await press(historyTabs(wrapper)[0]!.element, 'ArrowRight')
    expect(historyTabs(wrapper)[1]!.attributes('aria-selected')).toBe('true')
    expect(active()).toBe(historyTabs(wrapper)[1]!.element)
  },
  'panel/nav-page-mine-column/Tab': async () => {
    // The shell's real layout: walked in the built app.
    const row = rowOf('panel/nav-page-mine-column/Tab')
    if (row.proof.lane === 'jsdom') throw new Error('the Tab order needs the built app')
    const [file, title] = row.proof.proof.split(' :: ')
    expect(readFileSync(join(ROOT, file!), 'utf8')).toContain(title!)
  },
  'panel/settings-sections/ArrowUp': async () => {
    const wrapper = settingsPanel()
    expect(settingsSection(wrapper)).toBe('General')
    await press(wrapper.get('[role="tablist"]').element, 'ArrowUp')
    // Wraps from the first section to the last.
    expect(settingsSection(wrapper)).toBe('About')
  },
  'panel/settings-sections/ArrowDown': async () => {
    const wrapper = settingsPanel()
    await press(wrapper.get('[role="tablist"]').element, 'ArrowDown')
    expect(settingsSection(wrapper)).toBe('Appearance')
  },
  'panel/font-style/ArrowLeft': async () => {
    // From the first preset, back wraps to Custom.
    expect(await fontStyleAfter('ArrowLeft')).toEqual({ asked: 'custom', focused: 'custom' })
  },
  'panel/font-style/ArrowRight': async () => {
    expect(await fontStyleAfter('ArrowRight')).toEqual({
      asked: FONT_STYLES[1],
      focused: FONT_STYLES[1]
    })
  },
  'panel/font-style/ArrowUp': async () => {
    expect(await fontStyleAfter('ArrowUp')).toEqual({ asked: 'custom', focused: 'custom' })
  },
  'panel/font-style/ArrowDown': async () => {
    expect(await fontStyleAfter('ArrowDown')).toEqual({
      asked: FONT_STYLES[1],
      focused: FONT_STYLES[1]
    })
  }
}

function rowOf(id: string): KeyMapRow {
  const row = KEYBOARD_MAPS.find((entry) => entry.id === id)
  if (row === undefined) throw new Error('no row ' + id)
  return row
}

describe('the Panel keyboard maps (L12, 17 §1.12)', () => {
  it('[NFR-A11Y-06] every key of the Panel keyboard map does what its table row says, one row per key per surface', async () => {
    // One row per key per surface, exactly the design's: none missing, none invented.
    expect(KEYBOARD_MAPS.map((row) => row.id)).toEqual(DESIGN_ROWS)
    for (const row of KEYBOARD_MAPS) {
      expect(row.id, 'the id names its surface, place and key').toBe(
        `${row.surface}/${row.id.split('/')[1]}/${row.key}`
      )
      expect(row.where.length * row.does.length, row.id).toBeGreaterThan(0)
    }
    // Each row pressed where it says, against what it says.
    for (const row of KEYBOARD_MAPS) {
      const driver = DRIVERS[row.id]
      expect(driver, 'a check for ' + row.id).toBeDefined()
      try {
        await driver!()
      } catch (error) {
        throw new Error(`${row.id} (${row.where}: ${row.does}): ${(error as Error).message}`)
      } finally {
        for (const wrapper of mounted) wrapper.unmount()
        mounted = []
        document.body.innerHTML = ''
      }
    }
  })
})
