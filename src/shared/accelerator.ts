/**
 * Electron accelerator vocabulary for the user-configurable panel toggle (#17).
 *
 * This module is the heart of the feature and is deliberately PURE: no
 * Electron, no Node, no DOM. The renderer records a keydown and translates it
 * here; the main process re-validates the resulting string here before handing
 * it to `globalShortcut`. One vocabulary, two processes, no drift.
 *
 * Why translate from `event.code` rather than `event.key`: `key` is what the
 * layout produced (Shift turns 'p' into 'P', AltGr can turn it into '@', a
 * Dvorak or AZERTY layout moves it entirely), while `code` names the physical
 * key. Electron matches accelerators against the physical key, so `code` is the
 * only input that makes the recorded shortcut fire the way it looked when it
 * was recorded.
 *
 * Why validation refuses more than Electron would: `globalShortcut.register`
 * happily takes a bare 'P' and then swallows that key in every other
 * application on the machine. A global shortcut is a machine-wide claim, so the
 * rules here are intentionally stricter than the parser's.
 */

/** The documented default, unchanged from the original hardcoded constant. */
export const DEFAULT_TOGGLE_ACCELERATOR = 'Control+Alt+Shift+P'

/**
 * Only the distinctions that change a modifier's NAME matter here, so this is
 * not `NodeJS.Platform`: macOS says Cmd/Option, Windows says Win, and every
 * remaining platform gets the neutral X11 name.
 */
export type ShortcutPlatform = 'darwin' | 'win32' | 'other'

/**
 * The subset of `KeyboardEvent` the translation reads. Declaring it structurally
 * (rather than taking a KeyboardEvent) is what keeps this module DOM-free and
 * its tests free of jsdom.
 */
export interface KeyChord {
  code: string
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Either a canonical accelerator, or a reason a human can act on. */
export type AcceleratorResult = { ok: true; accelerator: string } | { ok: false; reason: string }

/**
 * Canonical modifier order. The chord only carries independent flags, so the
 * order is ours to fix — and it must be fixed, or two recordings of the same
 * combination would not compare equal and "is this still the default?" would
 * silently start lying.
 */
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super']

/** Every spelling Electron accepts, folded onto the canonical one above. */
const MODIFIER_ALIASES = new Map<string, string>([
  ['command', 'Command'],
  ['cmd', 'Command'],
  ['commandorcontrol', 'CommandOrControl'],
  ['cmdorctrl', 'CommandOrControl'],
  ['control', 'Control'],
  ['ctrl', 'Control'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['altgr', 'AltGr'],
  ['shift', 'Shift'],
  ['super', 'Super'],
  ['meta', 'Super']
])

/**
 * Modifiers that on their own make a shortcut safe to claim globally. Shift and
 * AltGr are excluded on purpose: both are pressed constantly while typing
 * ordinary text, so "Shift+P" would fire on every capital P anywhere on the
 * machine.
 */
const PRIMARY_MODIFIERS = new Set(['CommandOrControl', 'Command', 'Control', 'Alt', 'Super'])

/** `event.key` values that ARE a modifier — a half-typed chord, not a key. */
const MODIFIER_EVENT_KEYS = new Set([
  'Control',
  'Alt',
  'AltGraph',
  'Shift',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'Fn',
  'FnLock',
  'Symbol',
  'SymbolLock'
])

/**
 * Keys that are never part of a shortcut. Locks toggle state rather than firing;
 * Dead/Unidentified/Process mean the layout has not resolved a key at all; and
 * Escape is reserved because the recorder itself needs it to cancel.
 */
const UNUSABLE_EVENT_KEYS = new Set([
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Unidentified',
  'Process',
  'Escape',
  'ContextMenu'
])

/**
 * Pure: is this `event.key` a modifier, i.e. a chord still being typed? The
 * recorder needs this to tell "not finished yet" (stay listening, say nothing)
 * apart from "that is not a shortcut" (explain the refusal).
 */
export function isModifierKey(key: string): boolean {
  return MODIFIER_EVENT_KEYS.has(key)
}

/** Physical codes whose accelerator name differs from the code itself. */
const CODE_KEYS = new Map<string, string>([
  ['Space', 'Space'],
  ['Enter', 'Enter'],
  ['NumpadEnter', 'Enter'],
  ['Tab', 'Tab'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['Insert', 'Insert'],
  // Electron's vocabulary is Up/Down/Left/Right, not the DOM's Arrow* names.
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  // Punctuation is named by its UNSHIFTED character, matching how Electron
  // resolves the physical key.
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Backquote', '`'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
  // The keypad is a separate set of physical keys, so it gets separate names.
  ['NumpadAdd', 'numadd'],
  ['NumpadSubtract', 'numsub'],
  ['NumpadMultiply', 'nummult'],
  ['NumpadDivide', 'numdiv'],
  ['NumpadDecimal', 'numdec']
])

/** Named keys accepted when validating a string (the inverse of CODE_KEYS). */
const NAMED_KEYS = new Map<string, string>([
  ['space', 'Space'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['tab', 'Tab'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['insert', 'Insert'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  // '+' is the accelerator separator, so the character itself is spelled out.
  ['plus', 'Plus'],
  ['numadd', 'numadd'],
  ['numsub', 'numsub'],
  ['nummult', 'nummult'],
  ['numdiv', 'numdiv'],
  ['numdec', 'numdec']
])

/** Punctuation accepted verbatim as a key token. */
const PUNCTUATION_KEYS = new Set(['-', '=', '[', ']', '\\', ';', "'", '`', ',', '.', '/'])

const LETTER_CODE = /^Key([A-Z])$/
const DIGIT_CODE = /^Digit([0-9])$/
const NUMPAD_CODE = /^Numpad([0-9])$/
/** F1..F24 — the range Electron accepts; F25 and F0 are not keys. */
const FUNCTION_KEY = /^[fF]([1-9]|1[0-9]|2[0-4])$/

const NEEDS_KEY = 'A shortcut needs a key, not just modifiers.'
const NEEDS_MODIFIER =
  'A global shortcut needs at least one modifier — hold Ctrl, Alt or Cmd as well.'
const SHIFT_IS_NOT_ENOUGH =
  'Shift on its own is not enough — add Ctrl, Alt or Cmd, or the shortcut would fire while you type.'
const ONE_KEY_ONLY = 'A shortcut is one key plus its modifiers.'
const NOTHING_RECORDED = 'Press a key combination to record a shortcut.'

/**
 * Pure: the non-modifier half of a chord, or null when the pressed key cannot
 * be part of a shortcut at all. Order matters — the "is this a real key" checks
 * run BEFORE the code lookup, because a dead key still reports the physical
 * code of the key it was composed on (`Backquote` + `key: 'Dead'`).
 */
export function acceleratorKeyFromChord(chord: KeyChord): string | null {
  if (MODIFIER_EVENT_KEYS.has(chord.key) || UNUSABLE_EVENT_KEYS.has(chord.key)) return null

  const named = CODE_KEYS.get(chord.code)
  if (named !== undefined) return named

  const letter = LETTER_CODE.exec(chord.code)
  if (letter?.[1] !== undefined) return letter[1]

  const digit = DIGIT_CODE.exec(chord.code)
  if (digit?.[1] !== undefined) return digit[1]

  const numpad = NUMPAD_CODE.exec(chord.code)
  if (numpad?.[1] !== undefined) return `num${numpad[1]}`

  const fn = FUNCTION_KEY.exec(chord.code)
  if (fn?.[1] !== undefined) return `F${fn[1]}`

  // Last resort for on-screen keyboards, IMEs and exotic layouts that report no
  // (or an unknown) physical code: a single printable character is still an
  // unambiguous key. Anything longer is a name we do not know, and guessing at
  // a spelling would produce an accelerator Electron rejects at registration.
  if (chord.key.length === 1 && chord.key.trim() !== '') {
    return chord.key === '+' ? 'Plus' : chord.key.toUpperCase()
  }
  return null
}

/** Pure: the held modifiers, canonically named and ordered. */
export function modifiersFromChord(
  chord: KeyChord,
  platform: ShortcutPlatform = 'other'
): string[] {
  const modifiers: string[] = []
  if (chord.ctrlKey) modifiers.push('Control')
  if (chord.altKey) modifiers.push('Alt')
  if (chord.shiftKey) modifiers.push('Shift')
  // Electron resolves Super to Cmd on macOS too, but spelling it Command there
  // is what the user sees printed on the key.
  if (chord.metaKey) modifiers.push(platform === 'darwin' ? 'Command' : 'Super')
  return modifiers
}

/**
 * Pure: one recorded keydown -> a canonical accelerator, or the reason it is
 * not one. The assembled string is run back through validateAccelerator so the
 * recorder and a hand-edited preference file are held to exactly the same rules.
 */
export function buildAccelerator(
  chord: KeyChord,
  platform: ShortcutPlatform = 'other'
): AcceleratorResult {
  // A modifier keydown arrives before the real key does; that is a chord in
  // progress, and saying so is friendlier than "unusable key".
  if (MODIFIER_EVENT_KEYS.has(chord.key)) return { ok: false, reason: NEEDS_KEY }

  const key = acceleratorKeyFromChord(chord)
  if (key === null) return { ok: false, reason: 'That key cannot be used in a shortcut.' }

  return validateAccelerator([...modifiersFromChord(chord, platform), key].join('+'))
}

/**
 * Pure: is this string a shortcut we are willing to claim machine-wide, and
 * what is its one canonical spelling? Used at three boundaries — the recorder's
 * output, the IPC payload from the renderer, and the persisted file, which may
 * have been hand-edited or corrupted.
 */
export function validateAccelerator(accelerator: string): AcceleratorResult {
  const trimmed = accelerator.trim()
  if (trimmed === '') return { ok: false, reason: NOTHING_RECORDED }

  const modifiers = new Set<string>()
  const keys: string[] = []

  for (const raw of trimmed.split('+')) {
    const token = raw.trim()
    // An empty token means a stray or doubled separator ('Control++P'), which
    // Electron would parse into something the user never pressed.
    if (token === '') return { ok: false, reason: `"${trimmed}" is not a valid shortcut.` }

    const modifier = MODIFIER_ALIASES.get(token.toLowerCase())
    if (modifier !== undefined) {
      // A Set collapses a repeated modifier rather than emitting it twice.
      modifiers.add(modifier)
      continue
    }

    const key = canonicalKeyToken(token)
    if (key === null) return { ok: false, reason: `"${token}" cannot be used in a shortcut.` }
    keys.push(key)
  }

  if (keys.length === 0) return { ok: false, reason: NEEDS_KEY }
  if (keys.length > 1) return { ok: false, reason: ONE_KEY_ONLY }
  if (modifiers.size === 0) return { ok: false, reason: NEEDS_MODIFIER }
  if (![...modifiers].some((modifier) => PRIMARY_MODIFIERS.has(modifier))) {
    return { ok: false, reason: SHIFT_IS_NOT_ENOUGH }
  }

  const ordered = [...modifiers].sort(
    (a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)
  )
  return { ok: true, accelerator: [...ordered, ...keys].join('+') }
}

/** Pure: one token -> its canonical key spelling, or null when it is not a key. */
function canonicalKeyToken(token: string): string | null {
  const named = NAMED_KEYS.get(token.toLowerCase())
  if (named !== undefined) return named
  if (PUNCTUATION_KEYS.has(token)) return token
  if (/^[a-zA-Z]$/.test(token)) return token.toUpperCase()
  if (/^[0-9]$/.test(token)) return token

  const fn = FUNCTION_KEY.exec(token)
  if (fn?.[1] !== undefined) return `F${fn[1]}`

  const numpad = /^num([0-9])$/i.exec(token)
  if (numpad?.[1] !== undefined) return `num${numpad[1]}`

  return null
}

/** How each canonical token is printed on this platform's keyboard. */
const DISPLAY_NAMES: Record<ShortcutPlatform, Map<string, string>> = {
  darwin: new Map([
    ['Control', 'Ctrl'],
    ['Command', 'Cmd'],
    ['CommandOrControl', 'Cmd'],
    ['Alt', 'Option'],
    ['Super', 'Cmd']
  ]),
  win32: new Map([
    ['Control', 'Ctrl'],
    ['Command', 'Cmd'],
    ['CommandOrControl', 'Ctrl'],
    ['Super', 'Win']
  ]),
  other: new Map([
    ['Control', 'Ctrl'],
    ['Command', 'Cmd'],
    ['CommandOrControl', 'Ctrl'],
    ['Super', 'Super']
  ])
}

/** Keypad wire names -> what is actually printed on the keypad. */
const KEYPAD_DISPLAY = new Map<string, string>([
  ['numadd', 'Num +'],
  ['numsub', 'Num -'],
  ['nummult', 'Num *'],
  ['numdiv', 'Num /'],
  ['numdec', 'Num .']
])

/**
 * Pure: a canonical accelerator -> the label shown in the settings panel.
 * An unrecognized token is passed through untouched rather than dropped: a
 * label that is wrong is recoverable, a label that silently omits half the
 * combination is not.
 */
export function formatAccelerator(
  accelerator: string,
  platform: ShortcutPlatform = 'other'
): string {
  const names = DISPLAY_NAMES[platform]
  return accelerator
    .split('+')
    .map((token) => {
      const modifier = names.get(token)
      if (modifier !== undefined) return modifier
      if (token === 'Plus') return '+'
      const keypad = KEYPAD_DISPLAY.get(token)
      if (keypad !== undefined) return keypad
      const numpadDigit = /^num([0-9])$/.exec(token)
      if (numpadDigit?.[1] !== undefined) return `Num ${numpadDigit[1]}`
      return token
    })
    .join(' + ')
}
