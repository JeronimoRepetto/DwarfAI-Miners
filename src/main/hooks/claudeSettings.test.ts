import { describe, expect, it } from 'vitest'
import { HOOK_MARKER } from './hookCommand'
import {
  containsOurHooks,
  detectJsonFormat,
  installHookEntries,
  parseSettingsObject,
  removeHookEntries,
  stringifySettings,
  type JsonObject
} from './claudeSettings'

const OUR_COMMAND = `curl.exe -s -d@- http://127.0.0.1:47821/${HOOK_MARKER}`
const OLD_COMMAND = `curl.exe -s -d@- http://127.0.0.1:40000/${HOOK_MARKER}`
const SPEC = { events: ['SessionStart', 'Stop'] as const, command: OUR_COMMAND, timeoutS: 5 }

function ourGroup(command = OUR_COMMAND): JsonObject {
  return { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] }
}

const foreignGroup: JsonObject = {
  matcher: 'Bash',
  hooks: [{ command: 'rtk hook claude', type: 'command' }]
}

describe('installHookEntries', () => {
  it('creates the whole hooks tree in an empty settings file', () => {
    expect(installHookEntries({}, SPEC)).toEqual({
      hooks: { SessionStart: [ourGroup()], Stop: [ourGroup()] }
    })
  })

  it('omits the timeout when the spec has none', () => {
    expect(installHookEntries({}, { events: ['Stop'], command: OUR_COMMAND })).toEqual({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: OUR_COMMAND }] }] }
    })
  })

  it('preserves every unrelated top-level key', () => {
    const before: JsonObject = {
      model: 'claude-fable-5[1m]',
      permissions: { allow: ['mcp__codegraph__*'], defaultMode: 'bypassPermissions' },
      statusLine: { command: 'bash ~/.claude/statusline-command.sh', type: 'command' }
    }
    const after = installHookEntries(before, SPEC)
    expect(after.model).toBe(before.model)
    expect(after.permissions).toEqual(before.permissions)
    expect(after.statusLine).toEqual(before.statusLine)
  })

  it('never mutates the object it is given', () => {
    const before: JsonObject = { hooks: { Stop: [foreignGroup] } }
    const snapshot = structuredClone(before)
    installHookEntries(before, SPEC)
    expect(before).toEqual(snapshot)
  })

  it('appends after a foreign hook on the same event, leaving it untouched', () => {
    const after = installHookEntries({ hooks: { Stop: [foreignGroup] } }, SPEC)
    expect(after.hooks).toEqual({
      Stop: [foreignGroup, ourGroup()],
      SessionStart: [ourGroup()]
    })
  })

  it('leaves an event we do not target completely alone', () => {
    const before: JsonObject = { hooks: { UserPromptSubmit: [foreignGroup] } }
    const after = installHookEntries(before, SPEC) as { hooks: JsonObject }
    expect(after.hooks.UserPromptSubmit).toEqual([foreignGroup])
  })

  it('replaces our previous entry instead of duplicating it (re-install)', () => {
    const once = installHookEntries({}, SPEC)
    const twice = installHookEntries(once, SPEC)
    expect(twice).toEqual(once)
  })

  it('replaces an entry left by an earlier port or token', () => {
    const before: JsonObject = { hooks: { Stop: [ourGroup(OLD_COMMAND)] } }
    const after = installHookEntries(before, SPEC) as { hooks: JsonObject }
    expect(after.hooks.Stop).toEqual([ourGroup()])
  })

  it('drops our entry from a shared group but keeps the foreign sibling in place', () => {
    const shared: JsonObject = {
      hooks: [
        { type: 'command', command: 'node ./user-script.js' },
        { type: 'command', command: OLD_COMMAND }
      ]
    }
    const after = installHookEntries({ hooks: { Stop: [shared] } }, SPEC) as { hooks: JsonObject }
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'node ./user-script.js' }] },
      ourGroup()
    ])
  })

  it('preserves unknown keys inside a foreign group and inside foreign entries', () => {
    const exotic: JsonObject = {
      matcher: 'startup',
      description: 'set by another tool',
      hooks: [{ type: 'command', command: 'other', timeout: 30, retries: 2 }]
    }
    const after = installHookEntries({ hooks: { SessionStart: [exotic] } }, SPEC) as {
      hooks: JsonObject
    }
    expect((after.hooks.SessionStart as unknown[])[0]).toEqual(exotic)
  })

  it('leaves a malformed foreign group untouched rather than repairing it', () => {
    const after = installHookEntries(
      { hooks: { Stop: ['not-a-group', 7, null, { hooks: 'not-an-array' }] } },
      SPEC
    ) as { hooks: JsonObject }
    expect(after.hooks.Stop).toEqual([
      'not-a-group',
      7,
      null,
      { hooks: 'not-an-array' },
      ourGroup()
    ])
  })

  it.each([
    ['hooks is an array', { hooks: [] }],
    ['hooks is a string', { hooks: 'off' }],
    ['hooks is null', { hooks: null }]
  ])('refuses to write when %s', (_label, settings) => {
    expect(() => installHookEntries(settings as JsonObject, SPEC)).toThrow(/hooks/i)
  })

  it('refuses to write when a targeted event is not an array', () => {
    expect(() => installHookEntries({ hooks: { Stop: { a: 1 } } }, SPEC)).toThrow(/Stop/)
  })

  it('keeps the order of the events it was asked to install', () => {
    const after = installHookEntries(
      {},
      {
        events: ['SessionStart', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'],
        command: OUR_COMMAND
      }
    ) as { hooks: JsonObject }
    expect(Object.keys(after.hooks)).toEqual([
      'SessionStart',
      'Notification',
      'Stop',
      'SubagentStop',
      'SessionEnd'
    ])
  })
})

describe('removeHookEntries', () => {
  it('restores an untouched file to exactly what it was before install', () => {
    const before: JsonObject = {
      model: 'claude-fable-5[1m]',
      hooks: { PreToolUse: [foreignGroup] },
      tui: 'fullscreen'
    }
    expect(removeHookEntries(installHookEntries(before, SPEC))).toEqual(before)
  })

  it('drops the hooks key entirely when only our entries were in it', () => {
    const after = removeHookEntries(installHookEntries({ model: 'x' }, SPEC))
    expect(after).toEqual({ model: 'x' })
    expect(Object.hasOwn(after, 'hooks')).toBe(false)
  })

  it('drops an event key once our entry was its last group', () => {
    const before: JsonObject = { hooks: { Stop: [ourGroup()], PreToolUse: [foreignGroup] } }
    expect(removeHookEntries(before)).toEqual({ hooks: { PreToolUse: [foreignGroup] } })
  })

  it('removes only our entry from a group shared with a foreign one', () => {
    const shared: JsonObject = {
      matcher: '',
      hooks: [
        { type: 'command', command: OUR_COMMAND },
        { type: 'command', command: 'node ./user-script.js' }
      ]
    }
    expect(removeHookEntries({ hooks: { Stop: [shared] } })).toEqual({
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node ./user-script.js' }] }]
      }
    })
  })

  it('returns the very same object when there is nothing of ours to remove', () => {
    const before: JsonObject = { hooks: { PreToolUse: [foreignGroup] }, model: 'x' }
    expect(removeHookEntries(before)).toBe(before)
  })

  it('never mutates the object it is given', () => {
    const before = installHookEntries({ hooks: { Stop: [foreignGroup] } }, SPEC)
    const snapshot = structuredClone(before)
    removeHookEntries(before)
    expect(before).toEqual(snapshot)
  })

  it('preserves a user-authored empty event array it never touched', () => {
    const before: JsonObject = { hooks: { Stop: [], SessionStart: [ourGroup()] } }
    expect(removeHookEntries(before)).toEqual({ hooks: { Stop: [] } })
  })

  it.each([
    ['hooks is missing', { model: 'x' }],
    ['hooks is an array', { hooks: [] }],
    ['hooks is a string', { hooks: 'off' }]
  ])('leaves the file alone when %s', (_label, settings) => {
    expect(removeHookEntries(settings as JsonObject)).toBe(settings)
  })

  it('leaves a malformed event value untouched', () => {
    const before: JsonObject = { hooks: { Stop: { a: 1 }, SessionStart: [ourGroup()] } }
    expect(removeHookEntries(before)).toEqual({ hooks: { Stop: { a: 1 } } })
  })

  it('cleans up entries from an earlier port or token too', () => {
    expect(removeHookEntries({ hooks: { Stop: [ourGroup(OLD_COMMAND)] } })).toEqual({})
  })
})

describe('containsOurHooks', () => {
  it('reports false for a file that has none', () => {
    expect(containsOurHooks({ hooks: { PreToolUse: [foreignGroup] } })).toBe(false)
    expect(containsOurHooks({})).toBe(false)
    expect(containsOurHooks({ hooks: 'off' } as JsonObject)).toBe(false)
  })

  it('reports true once ours are installed, anywhere in the tree', () => {
    expect(containsOurHooks(installHookEntries({}, SPEC))).toBe(true)
    expect(containsOurHooks({ hooks: { Stop: [ourGroup(OLD_COMMAND)] } })).toBe(true)
  })
})

/*
 * #555. A Claude settings.json saved by a Windows editor opens with the
 * invisible EF BB BF, `JSON.parse` refuses it, and the installer skipped that
 * whole configuration directory — so sessions there silently never got the
 * instant-update hooks.
 *
 * The BOM ROUND-TRIPS rather than being dropped. This module's own header is
 * the reason: it is "the one place in the app that edits a file the user did
 * not create and cannot easily reconstruct", and it "preserves every key it
 * does not own". An encoding mark is part of that shape; silently re-encoding
 * somebody else's settings file is exactly the overreach the header forbids.
 */
describe('a settings.json a Windows editor marked (#555)', () => {
  const MARKED = '\uFEFF{\n  "model": "x"\n}\n'

  it('parses through the mark instead of refusing the file', () => {
    expect(parseSettingsObject(MARKED)).toEqual({ model: 'x' })
  })

  it('notices the mark as part of the file shape', () => {
    expect(detectJsonFormat(MARKED).byteOrderMark).toBe(true)
    expect(detectJsonFormat('{\n  "model": "x"\n}\n').byteOrderMark).toBe(false)
  })

  it('writes the mark back, so a marked file round-trips byte for byte', () => {
    expect(stringifySettings(parseSettingsObject(MARKED), detectJsonFormat(MARKED))).toBe(MARKED)
  })

  it('never adds a mark to a file that had none', () => {
    // The mirror of the rule above, and the half that would corrupt a file on
    // every machine rather than only on Windows.
    const plain = '{\n  "model": "x"\n}\n'
    expect(stringifySettings(parseSettingsObject(plain), detectJsonFormat(plain))).toBe(plain)
  })

  it('reads the rest of the format past the mark, not through it', () => {
    // The indent probe looks for the first indented line; a mark at position
    // zero must not shift what it finds, and CRLF detection must survive too.
    const marked = '\uFEFF{\r\n    "model": "x"\r\n}'
    expect(detectJsonFormat(marked)).toEqual({
      indent: '    ',
      eol: '\r\n',
      trailingNewline: false,
      byteOrderMark: true
    })
  })

  /*
   * The honest, general form of the round-trip above.
   *
   * `stringifySettings` reproduces the indent, the EOL and the trailing
   * newline — not every idiosyncrasy a writer may have had. A real
   * settings.json on the maintainer's machine puts TWO spaces after its
   * colons, which `JSON.stringify` does not reproduce, so it does not come
   * back byte-identical and never did. That is older than #555 and not what
   * this issue changes.
   *
   * What #555 must guarantee is narrower and exactly checkable: the mark adds
   * NO drift of its own. Whatever a file would have become without it, it
   * becomes with it, plus the mark — so tolerating a BOM can never be the
   * reason a file came back different.
   */
  it('adds no drift of its own beyond the mark, whatever the file’s quirks', () => {
    const quirky = '{\r\n    \"a\":  {\r\n        \"b\": 1\r\n    }\r\n}\r\n'
    const plain = stringifySettings(parseSettingsObject(quirky), detectJsonFormat(quirky))
    const marked = `﻿${quirky}`
    const throughMark = stringifySettings(parseSettingsObject(marked), detectJsonFormat(marked))
    expect(throughMark).toBe(`﻿${plain}`)
  })

  it('still refuses a marked file that is genuinely not a JSON object', () => {
    expect(() => parseSettingsObject('\uFEFF[1,2]')).toThrow()
    expect(() => parseSettingsObject('\uFEFFnot json')).toThrow()
  })
})

describe('parseSettingsObject', () => {
  it('parses a normal settings file', () => {
    expect(parseSettingsObject('{"model":"x"}')).toEqual({ model: 'x' })
  })

  it('treats an empty or whitespace-only file as empty settings', () => {
    expect(parseSettingsObject('')).toEqual({})
    expect(parseSettingsObject('  \n ')).toEqual({})
  })

  it.each([
    ['malformed JSON', '{ oops'],
    ['a JSONC comment, which Claude Code rejects too', '{\n// hi\n"model":"x"}'],
    ['a trailing comma', '{"model":"x",}'],
    ['a top-level array', '[1,2]'],
    ['a top-level string', '"x"'],
    ['null', 'null']
  ])('refuses %s rather than overwriting the file', (_label, text) => {
    expect(() => parseSettingsObject(text)).toThrow()
  })
})

describe('detectJsonFormat / stringifySettings', () => {
  it('round-trips a two-space file with a trailing newline byte for byte', () => {
    const text = '{\n  "model": "x",\n  "tui": "fullscreen"\n}\n'
    const format = detectJsonFormat(text)
    expect(stringifySettings(parseSettingsObject(text), format)).toBe(text)
  })

  it('preserves four-space indentation', () => {
    const text = '{\n    "model": "x"\n}\n'
    expect(stringifySettings(parseSettingsObject(text), detectJsonFormat(text))).toBe(text)
  })

  it('preserves tab indentation', () => {
    const text = '{\n\t"model": "x"\n}\n'
    expect(stringifySettings(parseSettingsObject(text), detectJsonFormat(text))).toBe(text)
  })

  it('preserves CRLF line endings', () => {
    const text = '{\r\n  "model": "x"\r\n}\r\n'
    expect(stringifySettings(parseSettingsObject(text), detectJsonFormat(text))).toBe(text)
  })

  it('preserves a missing trailing newline', () => {
    const text = '{\n  "model": "x"\n}'
    expect(stringifySettings(parseSettingsObject(text), detectJsonFormat(text))).toBe(text)
  })

  it('falls back to two spaces and a trailing newline for a brand new file', () => {
    // AMENDED for #555: JsonFormat gained `byteOrderMark`, because a BOM is
    // part of the shape of a file this app does not own and must round-trip
    // with the rest of it. The three original fields are unchanged.
    expect(detectJsonFormat('')).toEqual({
      indent: '  ',
      eol: '\n',
      trailingNewline: true,
      byteOrderMark: false
    })
    expect(stringifySettings({ model: 'x' }, detectJsonFormat(''))).toBe('{\n  "model": "x"\n}\n')
  })

  it('ignores a single-line file and keeps the default indent', () => {
    expect(detectJsonFormat('{"model":"x"}').indent).toBe('  ')
  })
})
