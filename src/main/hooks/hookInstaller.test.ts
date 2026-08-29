import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { containsOurHooks, parseSettingsObject } from './claudeSettings'
import { FakeHookFs } from './fakeHookFs'
import { HOOK_MARKER } from './hookCommand'
import {
  BACKUP_SUFFIX,
  INSTALLED_HOOK_EVENTS,
  SETTINGS_FILE,
  installClaudeHooks,
  uninstallClaudeHooks
} from './hookInstaller'

const COMMAND = `curl.exe -s -d@- http://127.0.0.1:47821/${HOOK_MARKER}`
const ROOT = 'C:/Users/j/.claude'
const SECOND_ROOT = 'C:/Users/j/.claude-multitec'
const SETTINGS = `${ROOT}/${SETTINGS_FILE}`
const BACKUP = `${SETTINGS}${BACKUP_SUFFIX}`

const EXISTING = `{
  "model": "claude-fable-5[1m]",
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "command": "rtk hook claude",
            "type": "command"
          }
        ],
        "matcher": "Bash"
      }
    ]
  },
  "tui": "fullscreen"
}
`

function setup(files: Record<string, string> = {}, roots = [ROOT]): FakeHookFs {
  const fs = new FakeHookFs()
  for (const root of roots) fs.addDir(root)
  for (const [path, content] of Object.entries(files)) fs.addFile(path, content)
  return fs
}

function install(fs: FakeHookFs, roots = [ROOT]) {
  return installClaudeHooks({ fs, roots, command: COMMAND, timeoutS: 5 })
}

function uninstall(fs: FakeHookFs, roots = [ROOT]) {
  return uninstallClaudeHooks({ fs, roots })
}

describe('installClaudeHooks', () => {
  it('creates settings.json when the root exists but the file does not', async () => {
    const fs = setup()
    const reports = await install(fs)
    // settingsPath is built with node:path, so its separator is the host's.
    expect(reports).toEqual([
      { root: ROOT, settingsPath: join(ROOT, SETTINGS_FILE), changed: true, backedUp: false }
    ])
    const written = parseSettingsObject(fs.read(SETTINGS)!)
    expect(Object.keys(written.hooks as object)).toEqual([...INSTALLED_HOOK_EVENTS])
    expect(containsOurHooks(written)).toBe(true)
  })

  it('does not create a backup for a file that did not exist', async () => {
    const fs = setup()
    await install(fs)
    expect(await fs.exists(BACKUP)).toBe(false)
  })

  it('skips a root that is not present on this machine', async () => {
    const fs = setup({}, [ROOT])
    const reports = await install(fs, [ROOT, SECOND_ROOT])
    expect(reports.map((r) => r.root)).toEqual([ROOT])
    expect(fs.paths()).not.toContain(`${SECOND_ROOT}\\${SETTINGS_FILE}`.replace(/\//g, '\\'))
  })

  it('installs into every Claude root that does exist', async () => {
    const fs = setup({}, [ROOT, SECOND_ROOT])
    const reports = await install(fs, [ROOT, SECOND_ROOT])
    expect(reports.map((r) => r.changed)).toEqual([true, true])
    expect(fs.read(`${SECOND_ROOT}/${SETTINGS_FILE}`)).toBeDefined()
  })

  it('backs the file up exactly once, before the first modification', async () => {
    const fs = setup({ [SETTINGS]: EXISTING })
    const first = await install(fs)
    expect(first[0]!.backedUp).toBe(true)
    expect(fs.read(BACKUP)).toBe(EXISTING)

    // A later, genuinely-changing install must not overwrite the pristine copy.
    await uninstall(fs)
    const second = await installClaudeHooks({ fs, roots: [ROOT], command: `${COMMAND}x` })
    expect(second[0]!.backedUp).toBe(false)
    expect(fs.read(BACKUP)).toBe(EXISTING)
  })

  it('preserves the foreign hook and every other key', async () => {
    const fs = setup({ [SETTINGS]: EXISTING })
    await install(fs)
    const after = parseSettingsObject(fs.read(SETTINGS)!)
    const hooks = after.hooks as Record<string, unknown>
    expect(after.model).toBe('claude-fable-5[1m]')
    expect(after.tui).toBe('fullscreen')
    expect(hooks.PreToolUse).toEqual([
      { hooks: [{ command: 'rtk hook claude', type: 'command' }], matcher: 'Bash' }
    ])
  })

  it('is idempotent: a second install writes nothing at all', async () => {
    const fs = setup({ [SETTINGS]: EXISTING })
    await install(fs)
    const afterFirst = fs.read(SETTINGS)
    const reports = await install(fs)
    expect(reports[0]!.changed).toBe(false)
    expect(fs.read(SETTINGS)).toBe(afterFirst)
  })

  it('keeps the file formatting so the diff is only our addition', async () => {
    const fs = setup({ [SETTINGS]: EXISTING })
    await install(fs)
    const after = fs.read(SETTINGS)!
    expect(after.startsWith('{\n  "model"')).toBe(true)
    expect(after.endsWith('}\n')).toBe(true)
    expect(after).not.toContain('\r\n')
  })

  it('reports an error and writes nothing when settings.json is unparseable', async () => {
    const fs = setup({ [SETTINGS]: '{ this is not json' })
    const reports = await install(fs)
    expect(reports[0]!.changed).toBe(false)
    expect(reports[0]!.error).toBeDefined()
    expect(fs.read(SETTINGS)).toBe('{ this is not json')
    expect(await fs.exists(BACKUP)).toBe(false)
  })

  it('reports an error and writes nothing when the hooks value is not an object', async () => {
    const fs = setup({ [SETTINGS]: '{"hooks":[]}' })
    const reports = await install(fs)
    expect(reports[0]!.error).toMatch(/hooks/i)
    expect(fs.read(SETTINGS)).toBe('{"hooks":[]}')
  })

  it('reports a failed write without claiming the root changed', async () => {
    const fs = setup({ [SETTINGS]: EXISTING })
    fs.failWrite = (path) => (path.includes(SETTINGS_FILE) ? new Error('EPERM') : null)
    const reports = await install(fs)
    expect(reports[0]!.changed).toBe(false)
    expect(reports[0]!.error).toMatch(/EPERM/)
  })

  it('keeps going when one root fails so the other still gets its hooks', async () => {
    const fs = setup({ [SETTINGS]: '{ broken' }, [ROOT, SECOND_ROOT])
    const reports = await install(fs, [ROOT, SECOND_ROOT])
    expect(reports[0]!.error).toBeDefined()
    expect(reports[1]!.changed).toBe(true)
  })
})

describe('uninstallClaudeHooks', () => {
  it('restores the file to exactly its pre-install bytes', async () => {
    const fs = setup({ [SETTINGS]: EXISTING })
    await install(fs)
    expect(fs.read(SETTINGS)).not.toBe(EXISTING)
    const reports = await uninstall(fs)
    expect(reports[0]!.changed).toBe(true)
    expect(fs.read(SETTINGS)).toBe(EXISTING)
  })

  it('leaves a fresh install as an empty settings object, not a deleted file', async () => {
    const fs = setup()
    await install(fs)
    await uninstall(fs)
    expect(parseSettingsObject(fs.read(SETTINGS)!)).toEqual({})
  })

  it('does nothing when our hooks were never installed', async () => {
    const fs = setup({ [SETTINGS]: EXISTING })
    const reports = await uninstall(fs)
    expect(reports[0]!.changed).toBe(false)
    expect(fs.read(SETTINGS)).toBe(EXISTING)
    expect(await fs.exists(BACKUP)).toBe(false)
  })

  it('does nothing when settings.json does not exist', async () => {
    const fs = setup()
    const reports = await uninstall(fs)
    expect(reports[0]!.changed).toBe(false)
    expect(await fs.exists(SETTINGS)).toBe(false)
  })

  it('removes our hooks from every root', async () => {
    const fs = setup({}, [ROOT, SECOND_ROOT])
    await install(fs, [ROOT, SECOND_ROOT])
    await uninstall(fs, [ROOT, SECOND_ROOT])
    for (const root of [ROOT, SECOND_ROOT]) {
      expect(containsOurHooks(parseSettingsObject(fs.read(`${root}/${SETTINGS_FILE}`)!))).toBe(
        false
      )
    }
  })

  it('backs the file up before removing, when install never had to', async () => {
    // A settings.json created after install (or an install that failed midway)
    // must still get a pristine copy before uninstall rewrites it.
    const fs = setup({ [SETTINGS]: EXISTING })
    await install(fs)
    await fs.remove(BACKUP)
    const withHooks = fs.read(SETTINGS)!
    await uninstall(fs)
    expect(fs.read(BACKUP)).toBe(withHooks)
  })

  it('reports an error and writes nothing when settings.json is unparseable', async () => {
    const fs = setup({ [SETTINGS]: 'nope' })
    const reports = await uninstall(fs)
    expect(reports[0]!.error).toBeDefined()
    expect(fs.read(SETTINGS)).toBe('nope')
  })
})

describe('INSTALLED_HOOK_EVENTS', () => {
  it('is the state-change set the evaluation settled on, and nothing per-tool-call', () => {
    expect(INSTALLED_HOOK_EVENTS).toEqual([
      'SessionStart',
      'Notification',
      'Stop',
      'SubagentStop',
      'SessionEnd'
    ])
  })
})
