import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import {
  DWARF_NAME_LABEL,
  RENAME_TITLE,
  renameAnnouncement,
  renameChanges,
  renameHint,
  renameLabel
} from './rename'

/*
 * Renaming a dwarf in place from the MessagePanel header (#635; decision log, Dwarf names;
 * screens/message.md, As built): what the name button and the field are called, the one hint the
 * field shows at a time, whether a save changes anything, and what is announced after it.
 */
describe('the rename controls', () => {
  it('titles the name "Rename", names it for the dwarf it renames, and labels the field', () => {
    expect(RENAME_TITLE).toBe('Rename')
    expect(renameLabel('Watcher')).toBe('Rename Watcher')
    expect(DWARF_NAME_LABEL).toBe('Dwarf name')
  })
})

describe('renameHint', () => {
  it('says how to save and cancel while the text is valid', () => {
    expect(renameHint('Watcher', null, 'dwarfai-55')).toEqual({
      text: 'Enter saves · Esc cancels',
      error: false
    })
  })

  it('says an empty field goes back to the base name, and white space alone is empty', () => {
    const empty = { text: 'Empty · Enter goes back to dwarfai-55', error: false }
    expect(renameHint('', null, 'dwarfai-55')).toEqual(empty)
    expect(renameHint('   ', null, 'dwarfai-55')).toEqual(empty)
  })

  it('counts the characters at the limit, in the error colour', () => {
    expect(renameHint('Keeper of the tier seals', 'long', 'dwarfai-53')).toEqual({
      text: '24 of 24 characters',
      error: true
    })
    // At 24 the field takes no more, whether or not a keystroke was just refused.
    expect(renameHint('Keeper of the tier seals', null, 'dwarfai-53').text).toBe(
      '24 of 24 characters'
    )
  })

  /*
   * The count is the saved name's, as the cap is (NAMES-QUESTIONS 1): white space the save trims or
   * collapses is not counted, so the field never reads more than 24 of 24.
   */
  it('counts the name that would be saved, not the spacing around it', () => {
    expect(renameHint('  Keeper of  the tier seals', 'long', 'dwarfai-53').text).toBe(
      '24 of 24 characters'
    )
    expect(renameHint('  Scout  ', null, 'dwarfai-53').text).toBe('Enter saves · Esc cancels')
  })

  it('says refused characters are not allowed, in the error colour, ahead of the count', () => {
    expect(renameHint('Scout', 'chars', 'dwarfai-53')).toEqual({
      text: 'Emoji and control characters are not allowed.',
      error: true
    })
    expect(renameHint('Keeper of the tier seals', 'chars', 'dwarfai-53').text).toBe(
      'Emoji and control characters are not allowed.'
    )
  })
})

describe('renameChanges', () => {
  it('is a change when the saved name would differ from the one the dwarf has', () => {
    expect(renameChanges('Watcher', defaultDwarf({ name: 'dwarfai-55' }))).toBe(true)
    expect(
      renameChanges('Warden', defaultDwarf({ name: 'dwarfai-55', customName: 'Watcher' }))
    ).toBe(true)
    // Empty, or the base name, removes a custom name: a change only while one is set.
    expect(renameChanges('', defaultDwarf({ name: 'dwarfai-55', customName: 'Watcher' }))).toBe(
      true
    )
    expect(renameChanges('dwarfai-55', defaultDwarf({ name: 'dwarfai-55' }))).toBe(false)
  })

  it('reads the text as main will save it', () => {
    const named = defaultDwarf({ name: 'dwarfai-55', customName: 'Watcher' })
    expect(renameChanges('  Watcher ', named)).toBe(false)
    expect(renameChanges('   ', defaultDwarf({ name: 'dwarfai-55' }))).toBe(false)
  })
})

describe('renameAnnouncement', () => {
  it('announces the name main saved, or the base name it went back to', () => {
    expect(renameAnnouncement({ saved: true, customName: 'Watcher' }, 'dwarfai-55')).toBe(
      'Renamed to Watcher'
    )
    expect(renameAnnouncement({ saved: true }, 'dwarfai-55')).toBe('Name reset to dwarfai-55')
  })

  it('says main’s own reason when nothing was saved', () => {
    expect(renameAnnouncement({ saved: false, reason: 'The name could not be saved.' }, 'x')).toBe(
      'The name could not be saved.'
    )
  })
})
