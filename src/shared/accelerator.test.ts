import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOGGLE_ACCELERATOR,
  buildAccelerator,
  formatAccelerator,
  isModifierKey,
  validateAccelerator,
  type KeyChord
} from './accelerator'

/**
 * A keydown with nothing held down; each test turns on only the modifiers it
 * cares about. Building chords by hand (rather than from a real KeyboardEvent)
 * is the point: the translation is pure, so it is tested without a DOM.
 */
function chord(overrides: Partial<KeyChord> = {}): KeyChord {
  return {
    code: '',
    key: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides
  }
}

/** Unwraps a chord expected to translate; fails loudly instead of silently skipping. */
function accelerate(overrides: Partial<KeyChord>, platform?: 'darwin' | 'win32' | 'other'): string {
  const result = buildAccelerator(chord(overrides), platform)
  if (!result.ok) throw new Error(`expected a translation, got refusal: ${result.reason}`)
  return result.accelerator
}

describe('buildAccelerator — key translation', () => {
  it('translates a letter from its physical code, not the layout-shifted character', () => {
    // Shift turns event.key into 'P' and AltGr can turn it into anything at
    // all; event.code is the stable identity of the key that was pressed.
    expect(
      accelerate({ code: 'KeyP', key: 'p', ctrlKey: true, altKey: true, shiftKey: true })
    ).toBe('Control+Alt+Shift+P')
    expect(accelerate({ code: 'KeyA', key: 'a', ctrlKey: true })).toBe('Control+A')
    expect(accelerate({ code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true })).toBe(
      'Control+Shift+Z'
    )
  })

  it('translates digit-row numbers to the bare digit', () => {
    expect(accelerate({ code: 'Digit7', key: '7', ctrlKey: true })).toBe('Control+7')
    expect(accelerate({ code: 'Digit0', key: ')', ctrlKey: true, shiftKey: true })).toBe(
      'Control+Shift+0'
    )
  })

  it('translates the whole function-key row, including F13..F24', () => {
    expect(accelerate({ code: 'F1', key: 'F1', altKey: true })).toBe('Alt+F1')
    expect(accelerate({ code: 'F12', key: 'F12', ctrlKey: true })).toBe('Control+F12')
    expect(accelerate({ code: 'F24', key: 'F24', ctrlKey: true })).toBe('Control+F24')
  })

  it('translates arrows to the short names Electron expects', () => {
    // Electron's accelerator vocabulary is Up/Down/Left/Right, not ArrowUp.
    expect(accelerate({ code: 'ArrowUp', key: 'ArrowUp', ctrlKey: true })).toBe('Control+Up')
    expect(accelerate({ code: 'ArrowDown', key: 'ArrowDown', ctrlKey: true })).toBe('Control+Down')
    expect(accelerate({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true })).toBe('Control+Left')
    expect(accelerate({ code: 'ArrowRight', key: 'ArrowRight', ctrlKey: true })).toBe(
      'Control+Right'
    )
  })

  it('translates the named editing and navigation keys', () => {
    expect(accelerate({ code: 'Space', key: ' ', ctrlKey: true })).toBe('Control+Space')
    expect(accelerate({ code: 'Enter', key: 'Enter', ctrlKey: true })).toBe('Control+Enter')
    expect(accelerate({ code: 'NumpadEnter', key: 'Enter', ctrlKey: true })).toBe('Control+Enter')
    expect(accelerate({ code: 'Tab', key: 'Tab', ctrlKey: true })).toBe('Control+Tab')
    expect(accelerate({ code: 'Backspace', key: 'Backspace', ctrlKey: true })).toBe(
      'Control+Backspace'
    )
    expect(accelerate({ code: 'Delete', key: 'Delete', ctrlKey: true })).toBe('Control+Delete')
    expect(accelerate({ code: 'Home', key: 'Home', ctrlKey: true })).toBe('Control+Home')
    expect(accelerate({ code: 'End', key: 'End', ctrlKey: true })).toBe('Control+End')
    expect(accelerate({ code: 'PageUp', key: 'PageUp', ctrlKey: true })).toBe('Control+PageUp')
    expect(accelerate({ code: 'PageDown', key: 'PageDown', ctrlKey: true })).toBe(
      'Control+PageDown'
    )
    expect(accelerate({ code: 'Insert', key: 'Insert', ctrlKey: true })).toBe('Control+Insert')
  })

  it('translates punctuation keys to their unshifted character', () => {
    expect(accelerate({ code: 'Minus', key: '_', ctrlKey: true, shiftKey: true })).toBe(
      'Control+Shift+-'
    )
    expect(accelerate({ code: 'Equal', key: '=', ctrlKey: true })).toBe('Control+=')
    expect(accelerate({ code: 'BracketLeft', key: '[', ctrlKey: true })).toBe('Control+[')
    expect(accelerate({ code: 'BracketRight', key: ']', ctrlKey: true })).toBe('Control+]')
    expect(accelerate({ code: 'Backslash', key: '\\', ctrlKey: true })).toBe('Control+\\')
    expect(accelerate({ code: 'Semicolon', key: ';', ctrlKey: true })).toBe('Control+;')
    expect(accelerate({ code: 'Quote', key: "'", ctrlKey: true })).toBe("Control+'")
    expect(accelerate({ code: 'Backquote', key: '`', ctrlKey: true })).toBe('Control+`')
    expect(accelerate({ code: 'Comma', key: ',', ctrlKey: true })).toBe('Control+,')
    expect(accelerate({ code: 'Period', key: '.', ctrlKey: true })).toBe('Control+.')
    expect(accelerate({ code: 'Slash', key: '/', ctrlKey: true })).toBe('Control+/')
  })

  it('translates the numeric keypad to Electron num* names, distinct from the digit row', () => {
    expect(accelerate({ code: 'Numpad3', key: '3', ctrlKey: true })).toBe('Control+num3')
    expect(accelerate({ code: 'NumpadAdd', key: '+', ctrlKey: true })).toBe('Control+numadd')
    expect(accelerate({ code: 'NumpadSubtract', key: '-', ctrlKey: true })).toBe('Control+numsub')
    expect(accelerate({ code: 'NumpadMultiply', key: '*', ctrlKey: true })).toBe('Control+nummult')
    expect(accelerate({ code: 'NumpadDivide', key: '/', ctrlKey: true })).toBe('Control+numdiv')
    expect(accelerate({ code: 'NumpadDecimal', key: '.', ctrlKey: true })).toBe('Control+numdec')
  })

  it('falls back to the character when the event carries no physical code', () => {
    // On-screen keyboards and some IMEs report an empty code; a single
    // printable character is still an unambiguous key.
    expect(accelerate({ code: '', key: 'p', ctrlKey: true })).toBe('Control+P')
    // '+' is the accelerator separator, so Electron spells it 'Plus'.
    expect(accelerate({ code: '', key: '+', ctrlKey: true })).toBe('Control+Plus')
  })
})

describe('buildAccelerator — modifier translation', () => {
  it('emits modifiers in one canonical order regardless of which were held', () => {
    // The chord only carries flags, so the order is ours to fix: a stable
    // order is what makes two recordings of the same combination compare equal.
    expect(
      accelerate({
        code: 'KeyX',
        key: 'x',
        metaKey: true,
        shiftKey: true,
        altKey: true,
        ctrlKey: true
      })
    ).toBe('Control+Alt+Shift+Super+X')
  })

  it('spells the Meta key as Command on macOS and Super everywhere else', () => {
    expect(accelerate({ code: 'KeyX', key: 'x', metaKey: true }, 'darwin')).toBe('Command+X')
    expect(accelerate({ code: 'KeyX', key: 'x', metaKey: true }, 'win32')).toBe('Super+X')
    expect(accelerate({ code: 'KeyX', key: 'x', metaKey: true }, 'other')).toBe('Super+X')
  })

  it('defaults to the portable spelling when no platform is given', () => {
    expect(accelerate({ code: 'KeyX', key: 'x', metaKey: true })).toBe('Super+X')
  })
})

describe('buildAccelerator — refusals', () => {
  it('refuses a modifier pressed on its own', () => {
    // The recorder sees a keydown for the modifier itself before the real key
    // arrives; that is a half-typed chord, never a shortcut.
    for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
      const result = buildAccelerator(
        chord({ code: `${key}Left`, key, ctrlKey: key === 'Control' })
      )
      expect(result.ok).toBe(false)
    }
  })

  it('explains a lone modifier differently from an unusable key', () => {
    const loneModifier = buildAccelerator(
      chord({ code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    )
    const unusableKey = buildAccelerator(
      chord({ code: 'CapsLock', key: 'CapsLock', ctrlKey: true })
    )
    expect(loneModifier.ok).toBe(false)
    expect(unusableKey.ok).toBe(false)
    if (loneModifier.ok || unusableKey.ok) return
    expect(loneModifier.reason).not.toBe(unusableKey.reason)
    expect(loneModifier.reason).toMatch(/key/i)
  })

  it('refuses a bare key with no modifier at all', () => {
    // A global shortcut with no modifier swallows that key in every other
    // application on the machine.
    const result = buildAccelerator(chord({ code: 'KeyP', key: 'p' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/modifier/i)
  })

  it('refuses Shift as the only modifier', () => {
    // Shift+P would fire on every capital P the user types anywhere.
    const result = buildAccelerator(chord({ code: 'KeyP', key: 'P', shiftKey: true }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Shift/)
  })

  it('refuses Escape, which the recorder itself needs as its cancel key', () => {
    expect(buildAccelerator(chord({ code: 'Escape', key: 'Escape', ctrlKey: true })).ok).toBe(false)
  })

  it('refuses lock keys, dead keys and unidentified keys', () => {
    for (const [code, key] of [
      ['CapsLock', 'CapsLock'],
      ['NumLock', 'NumLock'],
      ['ScrollLock', 'ScrollLock'],
      ['Backquote', 'Dead'],
      ['', 'Unidentified']
    ] as const) {
      expect(buildAccelerator(chord({ code, key, ctrlKey: true })).ok).toBe(false)
    }
  })

  it('refuses keys outside the vocabulary rather than guessing at a spelling', () => {
    expect(buildAccelerator(chord({ code: 'MediaPlayPause', key: 'MediaPlayPause' })).ok).toBe(
      false
    )
    expect(buildAccelerator(chord({ code: 'F25', key: 'F25', ctrlKey: true })).ok).toBe(false)
  })
})

describe('validateAccelerator', () => {
  it('accepts and canonicalizes a well-formed accelerator', () => {
    expect(validateAccelerator('Control+Alt+Shift+P')).toEqual({
      ok: true,
      accelerator: 'Control+Alt+Shift+P'
    })
  })

  it('normalizes aliases and casing to one canonical spelling', () => {
    // Two spellings of the same chord must compare equal, or "is this the
    // default?" and "did the accelerator change?" both become unreliable.
    expect(validateAccelerator('ctrl+alt+shift+p')).toEqual({
      ok: true,
      accelerator: 'Control+Alt+Shift+P'
    })
    expect(validateAccelerator('Cmd+K')).toEqual({ ok: true, accelerator: 'Command+K' })
    expect(validateAccelerator('Option+Control+K')).toEqual({
      ok: true,
      accelerator: 'Control+Alt+K'
    })
  })

  it('reorders modifiers into the canonical order', () => {
    expect(validateAccelerator('Shift+Control+P')).toEqual({
      ok: true,
      accelerator: 'Control+Shift+P'
    })
  })

  it('collapses a repeated modifier instead of emitting it twice', () => {
    expect(validateAccelerator('Control+Control+P')).toEqual({
      ok: true,
      accelerator: 'Control+P'
    })
  })

  it('tolerates surrounding whitespace around tokens', () => {
    expect(validateAccelerator(' Control + Shift + P ')).toEqual({
      ok: true,
      accelerator: 'Control+Shift+P'
    })
  })

  it('refuses modifiers with no key', () => {
    expect(validateAccelerator('Control').ok).toBe(false)
    expect(validateAccelerator('Control+Alt').ok).toBe(false)
  })

  it('refuses a key with no modifier, and Shift-only', () => {
    expect(validateAccelerator('P').ok).toBe(false)
    expect(validateAccelerator('Shift+P').ok).toBe(false)
  })

  it('refuses more than one key', () => {
    expect(validateAccelerator('Control+A+B').ok).toBe(false)
  })

  it('refuses empty, blank and malformed input', () => {
    expect(validateAccelerator('').ok).toBe(false)
    expect(validateAccelerator('   ').ok).toBe(false)
    expect(validateAccelerator('Control+').ok).toBe(false)
    expect(validateAccelerator('+P').ok).toBe(false)
    expect(validateAccelerator('Control++P').ok).toBe(false)
  })

  it('refuses tokens outside the key vocabulary', () => {
    // A string that only Electron could reject, at runtime, by throwing: it is
    // cheaper and far kinder to refuse it here.
    expect(validateAccelerator('Control+NotAKey').ok).toBe(false)
    expect(validateAccelerator('Control+F99').ok).toBe(false)
  })

  it('accepts CommandOrControl, which resolves per platform inside Electron', () => {
    expect(validateAccelerator('CmdOrCtrl+Shift+P')).toEqual({
      ok: true,
      accelerator: 'CommandOrControl+Shift+P'
    })
  })

  it('accepts every key the recorder can produce', () => {
    // Guards the two vocabularies against drifting apart: anything
    // buildAccelerator emits must survive a round trip through validation.
    for (const accelerator of [
      'Control+A',
      'Control+7',
      'Control+F24',
      'Control+Up',
      'Control+Space',
      'Control+Enter',
      'Control+Tab',
      'Control+Backspace',
      'Control+Delete',
      'Control+Home',
      'Control+End',
      'Control+PageUp',
      'Control+PageDown',
      'Control+Insert',
      'Control+-',
      'Control+=',
      'Control+[',
      'Control+]',
      'Control+\\',
      'Control+;',
      "Control+'",
      'Control+`',
      'Control+,',
      'Control+.',
      'Control+/',
      'Control+Plus',
      'Control+num3',
      'Control+numadd',
      'Control+numsub',
      'Control+nummult',
      'Control+numdiv',
      'Control+numdec',
      'Control+Alt+Shift+Super+X'
    ]) {
      expect(validateAccelerator(accelerator)).toEqual({ ok: true, accelerator })
    }
  })
})

describe('formatAccelerator', () => {
  it('spaces the tokens out and shortens Control for display', () => {
    expect(formatAccelerator('Control+Alt+Shift+P')).toBe('Ctrl + Alt + Shift + P')
  })

  it('uses the names printed on the keys of the running platform', () => {
    expect(formatAccelerator('Command+Alt+P', 'darwin')).toBe('Cmd + Option + P')
    expect(formatAccelerator('Super+P', 'darwin')).toBe('Cmd + P')
    expect(formatAccelerator('Super+P', 'win32')).toBe('Win + P')
    expect(formatAccelerator('Super+P', 'other')).toBe('Super + P')
    expect(formatAccelerator('CommandOrControl+P', 'win32')).toBe('Ctrl + P')
    expect(formatAccelerator('CommandOrControl+P', 'darwin')).toBe('Cmd + P')
  })

  it('spells the keypad out instead of leaking the num* wire names', () => {
    expect(formatAccelerator('Control+num3')).toBe('Ctrl + Num 3')
    expect(formatAccelerator('Control+numadd')).toBe('Ctrl + Num +')
    expect(formatAccelerator('Control+numdec')).toBe('Ctrl + Num .')
  })

  it('renders Plus as the character it stands for', () => {
    expect(formatAccelerator('Control+Plus')).toBe('Ctrl + +')
  })

  it('passes an unknown token through rather than dropping it from the display', () => {
    // Display must never silently shrink a combination; a user staring at a
    // wrong-but-complete label can at least re-record it.
    expect(formatAccelerator('Control+Whatever')).toBe('Ctrl + Whatever')
  })
})

describe('isModifierKey', () => {
  it('recognizes the keydowns that are only half a chord', () => {
    // The recorder sees these while the user is still reaching for the key, so
    // it needs to tell "not finished yet" apart from "that is not a shortcut".
    for (const key of ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']) {
      expect(isModifierKey(key)).toBe(true)
    }
  })

  it('does not mistake a real key for a modifier', () => {
    for (const key of ['p', 'P', 'Enter', 'ArrowUp', 'F5', ' ', 'CapsLock']) {
      expect(isModifierKey(key)).toBe(false)
    }
  })
})

describe('DEFAULT_TOGGLE_ACCELERATOR', () => {
  it('is the documented Ctrl+Alt+Shift+P and is itself canonical and valid', () => {
    expect(DEFAULT_TOGGLE_ACCELERATOR).toBe('Control+Alt+Shift+P')
    expect(validateAccelerator(DEFAULT_TOGGLE_ACCELERATOR)).toEqual({
      ok: true,
      accelerator: DEFAULT_TOGGLE_ACCELERATOR
    })
  })
})
