// layer: L2
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '@dwarfai/contracts'
import { FakeGlobalShortcutRegistry } from '../ports/fakes/FakeGlobalShortcutRegistry'
import { FakePanelWindowController } from '../ports/fakes/FakePanelWindowController'
import { createToggleShortcut, type ShortcutPreference, type ShortcutState } from './toggleShortcut'

/**
 * The Panel's global shortcut in UI main (05 §3.14; 16 §4.14; ADR-024 items 1, 9; 13 FM-047; NFR-PLAT-06): registered
 * at start and on every set, and the state A-10 / A-11 answer is always the real registration, never the request.
 */

/** The shortcut's UI preference, in memory (ADR-024 item 1: a UI-main persisted preference). */
class InMemoryShortcutPreference implements ShortcutPreference {
  readonly saves: string[] = []
  constructor(private stored: string = DEFAULT_TOGGLE_ACCELERATOR) {}

  load(): string {
    return this.stored
  }

  save(accelerator: string): void {
    this.saves.push(accelerator)
    this.stored = accelerator
  }
}

const OWNED_ELSEWHERE = 'Control+Alt+Shift+F9'
const FREE = 'Control+Shift+D'
const ALSO_FREE = 'Alt+Shift+K'

function started(options: { stored?: string; taken?: string[] } = {}) {
  const registry = new FakeGlobalShortcutRegistry(options.taken)
  const preference = new InMemoryShortcutPreference(options.stored)
  const panel = new FakePanelWindowController({ visible: true })
  const toggle = createToggleShortcut({ registry, preference, panel, platform: 'win32' })
  const atStart = toggle.start()
  return { registry, preference, panel, toggle, atStart }
}

/** What the renderer's "Reset to default" reads from the state (US-SET-002.AC02, AC03). */
function resetAllowed(state: ShortcutState): boolean {
  return !(state.accelerator === DEFAULT_TOGGLE_ACCELERATOR && state.registered)
}

describe('toggle shortcut (US-SHELL-008, US-SET-002, FM-047)', () => {
  it('[US-SHELL-008.AC01, US-SET-001.AC04, FM-047] when registration fails the state answers not registered with the recorded combination', () => {
    const { toggle, atStart, registry } = started({
      stored: OWNED_ELSEWHERE,
      taken: [OWNED_ELSEWHERE]
    })

    expect(atStart.registered).toBe(false)
    expect(atStart.accelerator).toBe(OWNED_ELSEWHERE)
    expect(toggle.state()).toEqual(atStart)
    expect(registry.heldAccelerators).toEqual([])
  })

  it('[US-SHELL-008.AC02, US-SET-002.AC04] a failed registration answers the error the General banner and row help need', () => {
    const { atStart } = started({ stored: OWNED_ELSEWHERE, taken: [OWNED_ELSEWHERE] })

    expect(atStart).toEqual({
      accelerator: OWNED_ELSEWHERE,
      registered: false,
      platform: 'win32',
      error:
        'Ctrl + Alt + Shift + F9 is already in use by another application. The panel can still be opened from the tray icon.'
    })
    expect(resetAllowed(atStart)).toBe(true)
  })

  it('[US-SHELL-008.AC03] setting a combination that registers answers registered and the previous failure is gone', () => {
    const { toggle, registry, preference } = started({
      stored: OWNED_ELSEWHERE,
      taken: [OWNED_ELSEWHERE]
    })

    const answer = toggle.set(FREE)

    expect(answer).toEqual({ accelerator: FREE, registered: true, platform: 'win32' })
    expect(toggle.state()).toEqual(answer)
    expect(registry.heldAccelerators).toEqual([FREE])
    expect(preference.load()).toBe(FREE)
  })

  it('[US-SET-002.AC02] the platform default, registered, answers "is default and registered"', () => {
    const { atStart, registry } = started()

    expect(atStart).toEqual({
      accelerator: DEFAULT_TOGGLE_ACCELERATOR,
      registered: true,
      platform: 'win32'
    })
    expect(registry.heldAccelerators).toEqual([DEFAULT_TOGGLE_ACCELERATOR])
    expect(resetAllowed(atStart)).toBe(false)
  })

  it('[US-SET-002.AC03] a non-default combination, or the default that failed, answers "reset allowed"', () => {
    const nonDefault = started({ stored: FREE }).atStart
    const defaultFailed = started({ taken: [DEFAULT_TOGGLE_ACCELERATOR] }).atStart

    expect(nonDefault).toMatchObject({ accelerator: FREE, registered: true })
    expect(resetAllowed(nonDefault)).toBe(true)
    expect(defaultFailed).toMatchObject({
      accelerator: DEFAULT_TOGGLE_ACCELERATOR,
      registered: false
    })
    expect(resetAllowed(defaultFailed)).toBe(true)
  })

  it('[US-SET-002.AC06] two sets in a row keep only the last combination', () => {
    const { toggle, registry, preference } = started()

    toggle.set(FREE)
    const answer = toggle.set(ALSO_FREE)

    expect(answer).toEqual({ accelerator: ALSO_FREE, registered: true, platform: 'win32' })
    expect(registry.heldAccelerators).toEqual([ALSO_FREE])
    expect(registry.unregisterCalls).toEqual([DEFAULT_TOGGLE_ACCELERATOR, FREE])
    expect(preference.load()).toBe(ALSO_FREE)
  })

  it('[US-SET-002.AC07] no set call leaves the stored combination and its registration untouched', () => {
    const { toggle, registry, preference, atStart } = started({ stored: FREE })

    const reads = [toggle.state(), toggle.state()]

    expect(reads).toEqual([atStart, atStart])
    expect(preference.saves).toEqual([])
    expect(preference.load()).toBe(FREE)
    expect(registry.registerCalls).toEqual([FREE])
    expect(registry.unregisterCalls).toEqual([])
    expect(registry.heldAccelerators).toEqual([FREE])
  })

  it('[NFR-PLAT-06] firing the registered shortcut toggles the Panel', () => {
    const { registry, panel, toggle } = started()

    expect(registry.press(DEFAULT_TOGGLE_ACCELERATOR)).toBe(true)
    expect(panel.visible).toBe(false)
    toggle.set(FREE)
    expect(registry.press(FREE)).toBe(true)
    expect(panel.visible).toBe(true)
    expect(panel.calls).toEqual(['toggleVisible', 'toggleVisible'])
  })

  it('[US-SHELL-008.AC03, ADR-024] a set that is refused keeps the working combination registered and stored, and says why', () => {
    const { toggle, registry, preference } = started({ taken: [OWNED_ELSEWHERE] })

    const answer = toggle.set(OWNED_ELSEWHERE)

    expect(answer).toEqual({
      accelerator: DEFAULT_TOGGLE_ACCELERATOR,
      registered: true,
      platform: 'win32',
      error:
        'Ctrl + Alt + Shift + F9 is already in use by another application. Still using Ctrl + Alt + Shift + P.'
    })
    expect(registry.heldAccelerators).toEqual([DEFAULT_TOGGLE_ACCELERATOR])
    expect(preference.load()).toBe(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('[US-SET-002.AC04, ADR-024] an invalid accelerator is refused with the reason and releases nothing', () => {
    const { toggle, registry, preference } = started()

    const answer = toggle.set('P')

    expect(answer.accelerator).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(answer.registered).toBe(true)
    expect(answer.error).toBe(
      'A global shortcut needs at least one modifier — hold Ctrl, Alt or Cmd as well.'
    )
    expect(registry.registerCalls).toEqual([DEFAULT_TOGGLE_ACCELERATOR])
    expect(registry.unregisterCalls).toEqual([])
    expect(preference.saves).toEqual([])
  })

  it('[US-SET-002.AC03] a stored combination that is not usable starts on the platform default', () => {
    const { atStart } = started({ stored: 'P' })

    expect(atStart).toEqual({
      accelerator: DEFAULT_TOGGLE_ACCELERATOR,
      registered: true,
      platform: 'win32'
    })
  })

  it('[US-SHELL-008.AC03] setting the default again after it was freed retries it, since nothing is held', () => {
    const { toggle, registry } = started({ taken: [DEFAULT_TOGGLE_ACCELERATOR] })
    registry.takenByOthers.delete(DEFAULT_TOGGLE_ACCELERATOR)

    const answer = toggle.set(DEFAULT_TOGGLE_ACCELERATOR)

    expect(answer).toEqual({
      accelerator: DEFAULT_TOGGLE_ACCELERATOR,
      registered: true,
      platform: 'win32'
    })
    expect(registry.unregisterCalls).toEqual([])
    expect(registry.heldAccelerators).toEqual([DEFAULT_TOGGLE_ACCELERATOR])
  })

  it('[NFR-PLAT-06] dispose releases the held combination', () => {
    const { toggle, registry } = started()

    toggle.dispose()

    expect(registry.heldAccelerators).toEqual([])
    expect(toggle.state().registered).toBe(false)
  })
})
