/*
 * Renaming a dwarf in place from the MessagePanel header (#635; decision log, Dwarf names;
 * screens/message.md, As built): the name is a button that becomes the kit's Input, and this
 * decides what the two are called, the one hint the field shows at a time, whether a save changes
 * anything, and what is announced once main has answered. The panel draws; this decides.
 *
 * What a name may hold, and what a save keeps, is shared/dwarfName's: main cleans every write with
 * the same rules, so nothing here second-guesses what main will save.
 */
import {
  DWARF_NAME_MAX,
  cleanDwarfName,
  customNameFor,
  nameChars,
  type DwarfNameRefusal
} from '../../../../shared/dwarfName'
import type { Dwarf, DwarfNameResult } from '../../types'

/** The name button's title; its accessible name is `renameLabel`. */
export const RENAME_TITLE = 'Rename'

/** The accessible name of the name button: "Rename <name>", the name it shows. */
export function renameLabel(name: string): string {
  return 'Rename ' + name
}

/** The field that takes the name's place while renaming. */
export const DWARF_NAME_LABEL = 'Dwarf name'

export interface RenameHint {
  text: string
  /** In the error colour, with the field's invalid edge beside it. */
  error: boolean
}

/**
 * The hint under the field, one at a time (screens/message.md, As built): refused characters
 * first, since the field just dropped what the person typed; then the count once the name is at
 * the cap, where the field takes no more; then what an empty field saves as; and otherwise how to
 * save and cancel.
 *
 * The count is the name that would be SAVED (NAMES-QUESTIONS 1): the field keeps the person's own
 * spacing, which the save trims and collapses, so counting the raw text could read past 24.
 */
export function renameHint(
  value: string,
  refused: DwarfNameRefusal | null,
  baseName: string
): RenameHint {
  if (refused === 'chars') {
    return { text: 'Emoji and control characters are not allowed.', error: true }
  }
  const count = nameChars(cleanDwarfName(value)).length
  if (refused === 'long' || count >= DWARF_NAME_MAX) {
    return { text: count + ' of ' + DWARF_NAME_MAX + ' characters', error: true }
  }
  if (value.trim() === '') return { text: 'Empty · Enter goes back to ' + baseName, error: false }
  return { text: 'Enter saves · Esc cancels', error: false }
}

/**
 * Whether saving this text would leave the dwarf with another name than it has: read as main will
 * save it (customNameFor), so a save that changes nothing asks main for nothing and announces
 * nothing, as the prototype's DM.setDwarfName returns before emitting.
 */
export function renameChanges(text: string, dwarf: Pick<Dwarf, 'name' | 'customName'>): boolean {
  return customNameFor(text, dwarf.name) !== dwarf.customName
}

/**
 * What the panel's polite status says once main has answered a rename or a reset: "Renamed to
 * <name>" with the name main saved, "Name reset to <base name>" when the dwarf shows its base name
 * again, and main's own reason when nothing was saved.
 */
export function renameAnnouncement(result: DwarfNameResult, baseName: string): string {
  if (!result.saved) return result.reason
  return result.customName === undefined
    ? 'Name reset to ' + baseName
    : 'Renamed to ' + result.customName
}

/** What main's answer to a rename or a reset says, and whether it is a warning everyone sees. */
export interface RenameNotice {
  text: string
  /** True when nothing was saved: a warning toast, never the panel's screen-reader-only status. */
  warning: boolean
}

/**
 * Where main's answer is said (BR-19): a save or a reset is announced in the panel's polite status
 * (accessibility.md, names); a rename or a reset that saved nothing is main's own reason as a warning
 * toast, which everyone sees and the toast host announces politely. A failure is never said to
 * screen readers alone.
 */
export function renameNotice(result: DwarfNameResult, baseName: string): RenameNotice {
  return { text: renameAnnouncement(result, baseName), warning: !result.saved }
}
