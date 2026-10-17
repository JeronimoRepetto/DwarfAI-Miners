/*
 * The Panel's keyboard maps as data (ISSUE-266; NFR-A11Y-06): one row per key per surface, transcribed from the
 * design's accessibility tables ("Keyboard: everywhere" and "Keyboard: Panel"), which are the one copy of them. Veta
 * and Valle keep their own maps (EPIC-19, EPIC-20). The rows are a test's table, never drawn: `keyboardMaps.test.ts`
 * presses each key where its row says and checks it does what the row says, so a map and its behaviour cannot drift.
 */

/** Which of the design's tables a row is from. */
export type KeyMapSurface = 'everywhere' | 'panel'

/**
 * Where a row is proven. `jsdom` rows are pressed in `keyboardMaps.test.ts`; an `e2e` row needs the built app's
 * real layout and is pressed in the L9 case named by `proof`; a `main` row is heard by Electron main, not the
 * renderer, and is proven by the test file named by `proof`.
 */
export type KeyMapProof = { lane: 'jsdom' } | { lane: 'e2e' | 'main'; proof: string }

export interface KeyMapRow {
  /** Stable, unique: `<surface>/<where>/<key>`. */
  id: string
  surface: KeyMapSurface
  /** One key or one chord, as `KeyboardEvent.key` names it, with its modifiers. */
  key: string
  /** The design's "Where" column. */
  where: string
  /** The design's "Does" column, for this one key. */
  does: string
  proof: KeyMapProof
}

const JSDOM: KeyMapProof = { lane: 'jsdom' }

/** A row of the "everywhere" table that the renderer hears. */
const everywhere = (place: string, key: string, where: string, does: string): KeyMapRow => ({
  id: `everywhere/${place}/${key}`,
  surface: 'everywhere',
  key,
  where,
  does,
  proof: JSDOM
})

/** A row of the "Panel" table that the renderer hears. */
const panel = (place: string, key: string, where: string, does: string): KeyMapRow => ({
  id: `panel/${place}/${key}`,
  surface: 'panel',
  key,
  where,
  does,
  proof: JSDOM
})

export const KEYBOARD_MAPS: readonly KeyMapRow[] = [
  {
    ...everywhere(
      'any-mode',
      'Control+Alt+Shift+P',
      'Any mode',
      'Hides and shows the app: the default of the configurable global shortcut.'
    ),
    // A global shortcut is registered and heard by Electron main; this file pins the default it registers.
    proof: { lane: 'main', proof: 'src/shared/accelerator.ts' }
  },
  everywhere(
    'any-layer',
    'Escape',
    'Any layer',
    'Closes the topmost menu, tooltip, picker, dialog or chat; focus returns to its opener.'
  ),
  everywhere(
    'search-field',
    'Escape',
    'A search field with text',
    'Clears the text first, and goes no further.'
  ),
  everywhere('menus', 'ArrowUp', 'Menus', 'Moves to the previous enabled item, wrapping.'),
  everywhere('menus', 'ArrowDown', 'Menus', 'Moves to the next enabled item, wrapping.'),
  everywhere('menus', 'Home', 'Menus', 'Jumps to the first enabled item.'),
  everywhere('menus', 'End', 'Menus', 'Jumps to the last enabled item.'),
  everywhere('menus', 'Enter', 'Menus', 'Picks the focused item.'),
  everywhere('menus', 'Tab', 'Menus', 'Closes the menu.'),
  everywhere('dialogs', 'Tab', 'Dialogs', 'Cycles forward inside the dialog only.'),
  everywhere('dialogs', 'Shift+Tab', 'Dialogs', 'Cycles backward inside the dialog only.'),
  everywhere(
    'typed-confirmation',
    'Enter',
    'Typed confirmation',
    'Confirms once the typed word matches, and not before.'
  ),
  everywhere('composer', 'Enter', 'Composer', 'Sends.'),
  everywhere('composer', 'Shift+Enter', 'Composer', 'Starts a new line, and sends nothing.'),
  everywhere(
    'message-panel-name',
    'Enter',
    'MessagePanel name',
    'Opens the "Dwarf name" field with the name selected.'
  ),
  everywhere(
    'message-panel-name',
    'F2',
    'MessagePanel name',
    'Opens the "Dwarf name" field with the name selected.'
  ),
  everywhere(
    'message-panel-name-field',
    'Enter',
    'The "Dwarf name" field',
    'Saves the name; focus returns to the name.'
  ),
  everywhere(
    'message-panel-name-field',
    'Escape',
    'The "Dwarf name" field',
    'Cancels and keeps the panel open; only the next Esc closes it.'
  ),
  everywhere(
    'question-card',
    '1-9',
    'Question card',
    'A digit picks the option with that number, "Other thing…" included; picking never sends.'
  ),
  everywhere(
    'question-card',
    'Enter',
    'Question card',
    'Goes to the next step once answered; does nothing on the last step.'
  ),
  everywhere(
    'add-panel-prompt',
    'Control+Enter',
    'Add panel prompt',
    'Sends the dwarf in once a supplier and a prompt are valid (Cmd+Enter on macOS).'
  ),
  everywhere('history-tabs', 'ArrowLeft', 'History tabs', 'Moves to the previous dwarf, wrapping.'),
  everywhere('history-tabs', 'ArrowRight', 'History tabs', 'Moves to the next dwarf, wrapping.'),
  {
    ...panel(
      'nav-page-mine-column',
      'Tab',
      'Nav, page, mine column',
      'Walks the nav slots, then the page, then the open mine and its dwarfs.'
    ),
    // The order of the shell's parts on either dock needs the built app's real layout.
    proof: {
      lane: 'e2e',
      proof:
        'e2e/panel/a11y.e2e.ts :: [NFR-A11Y-13] Tab order is the same logical order on both docks, whatever the visual order'
    }
  },
  panel(
    'settings-sections',
    'ArrowUp',
    'Settings section list',
    'Moves to the previous section, wrapping.'
  ),
  panel(
    'settings-sections',
    'ArrowDown',
    'Settings section list',
    'Moves to the next section, wrapping.'
  ),
  panel(
    'font-style',
    'ArrowLeft',
    'Font style',
    'Moves the choice to the previous preset, wrapping.'
  ),
  panel('font-style', 'ArrowRight', 'Font style', 'Moves the choice to the next preset, wrapping.'),
  panel(
    'font-style',
    'ArrowUp',
    'Font style',
    'Moves the choice to the previous preset, wrapping.'
  ),
  panel('font-style', 'ArrowDown', 'Font style', 'Moves the choice to the next preset, wrapping.')
]
