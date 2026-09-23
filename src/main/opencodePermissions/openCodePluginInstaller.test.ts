import { describe, expect, it } from 'vitest'
import { FakeHookFs } from '../hooks/fakeHookFs'
import {
  buildOpenCodePluginFile,
  installOpenCodePlugin,
  OPENCODE_PLUGIN_FILE,
  OPENCODE_PLUGIN_HEADER,
  openCodeGlobalPluginDir,
  openCodePluginSource,
  uninstallOpenCodePlugin
} from './openCodePluginInstaller'

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const PUSH_URL = 'http://127.0.0.1:47821/dwarfai-miners-hook/opencode'
const PLUGIN_DIR = 'C:/Users/j/.config/opencode/plugin'
const PLUGIN_PATH = `${PLUGIN_DIR}/${OPENCODE_PLUGIN_FILE}`

describe('openCodeGlobalPluginDir (#588 T6)', () => {
  // docs/opencode-format.md Row 15: OpenCode resolves its global config as
  // $XDG_CONFIG_HOME/opencode when set, else ~/.config/opencode, with NO
  // platform branch -- so the same rule holds on all three platforms, and
  // only the path syntax differs.
  it.each([
    ['win32', 'C:\\Users\\j', {}, 'C:\\Users\\j\\.config\\opencode\\plugin'],
    ['darwin', '/Users/j', {}, '/Users/j/.config/opencode/plugin'],
    ['linux', '/home/j', {}, '/home/j/.config/opencode/plugin'],
    ['linux', '/home/j', { XDG_CONFIG_HOME: '/home/j/cfg' }, '/home/j/cfg/opencode/plugin'],
    ['darwin', '/Users/j', { XDG_CONFIG_HOME: '/Users/j/cfg' }, '/Users/j/cfg/opencode/plugin'],
    ['win32', 'C:\\Users\\j', { XDG_CONFIG_HOME: 'D:\\cfg' }, 'D:\\cfg\\opencode\\plugin']
  ] as const)('on %s with home %s and %o resolves %s', (platform, home, env, expected) => {
    expect(openCodeGlobalPluginDir(home, env, platform)).toBe(expected)
  })

  it('treats a blank XDG_CONFIG_HOME as unset, like every other layer here', () => {
    expect(openCodeGlobalPluginDir('/home/j', { XDG_CONFIG_HOME: '  ' }, 'linux')).toBe(
      '/home/j/.config/opencode/plugin'
    )
  })

  it('refuses a relative XDG_CONFIG_HOME rather than guessing which directory OpenCode resolves it against', () => {
    expect(openCodeGlobalPluginDir('/home/j', { XDG_CONFIG_HOME: 'cfg' }, 'linux')).toBeNull()
    expect(openCodeGlobalPluginDir('C:\\Users\\j', { XDG_CONFIG_HOME: 'cfg' }, 'win32')).toBeNull()
  })
})

describe('buildOpenCodePluginFile (#588 T6)', () => {
  it('bakes the real address and token into the shipped artifact, under the ownership header', () => {
    const file = buildOpenCodePluginFile({
      source: openCodePluginSource,
      pushUrl: PUSH_URL,
      token: TOKEN
    })
    expect(file.startsWith(`${OPENCODE_PLUGIN_HEADER}\n`)).toBe(true)
    expect(file).toContain(`const PUSH_URL = '${PUSH_URL}'`)
    expect(file).toContain(`const PUSH_TOKEN = '${TOKEN}'`)
    expect(file).not.toContain('__DWARFAI_OPENCODE_PUSH_')
    expect(file).toContain('export const DwarfAiOpenCodePermissionPlugin')
  })

  it('refuses a source whose placeholders are not there exactly once, rather than writing a plugin that posts nowhere', () => {
    expect(() =>
      buildOpenCodePluginFile({ source: 'const x = 1', pushUrl: PUSH_URL, token: TOKEN })
    ).toThrow(/placeholder/i)
  })

  it.each([
    ['a token that is not hex', 'not-a-token', PUSH_URL],
    ['an address that is not loopback http', TOKEN, 'https://example.com/x'],
    ['an address carrying a quote', TOKEN, "http://127.0.0.1:1/'"]
  ])(
    'refuses %s, which could not be baked into a string literal safely',
    (_label, token, pushUrl) => {
      expect(() =>
        buildOpenCodePluginFile({ source: openCodePluginSource, pushUrl, token })
      ).toThrow()
    }
  )
})

describe('installOpenCodePlugin (#588 T6)', () => {
  const content = `${OPENCODE_PLUGIN_HEADER}\nexport const x = 1\n`

  it('creates the plugin directory when OpenCode has none yet, and says it did', async () => {
    const fs = new FakeHookFs()
    const report = await installOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, content })
    expect(report).toEqual({
      path: expect.stringContaining(OPENCODE_PLUGIN_FILE),
      changed: true,
      createdDir: true
    })
    expect(fs.read(PLUGIN_PATH)).toBe(content)
  })

  it('writes into an existing directory without claiming to have created it', async () => {
    const fs = new FakeHookFs()
    fs.addDir(PLUGIN_DIR)
    const report = await installOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, content })
    expect(report.createdDir).toBe(false)
    expect(report.changed).toBe(true)
  })

  it('leaves identical bytes alone', async () => {
    const fs = new FakeHookFs()
    fs.addDir(PLUGIN_DIR)
    fs.addFile(PLUGIN_PATH, content)
    const report = await installOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, content })
    expect(report.changed).toBe(false)
  })

  it('refreshes a file this app wrote before, for a new port or token', async () => {
    const fs = new FakeHookFs()
    fs.addDir(PLUGIN_DIR)
    fs.addFile(PLUGIN_PATH, `${OPENCODE_PLUGIN_HEADER}\nold\n`)
    const report = await installOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, content })
    expect(report.changed).toBe(true)
    expect(fs.read(PLUGIN_PATH)).toBe(content)
  })

  it('never overwrites a file of the same name that this app did not write', async () => {
    const fs = new FakeHookFs()
    fs.addDir(PLUGIN_DIR)
    fs.addFile(PLUGIN_PATH, 'export const theirs = 1\n')
    const report = await installOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, content })
    expect(report.changed).toBe(false)
    expect(report.error).toMatch(/did not write/i)
    expect(fs.read(PLUGIN_PATH)).toBe('export const theirs = 1\n')
  })

  it('writes the plugin owner-only (#588 T6 security fix): the file carries this install token in plain text', async () => {
    const fs = new FakeHookFs()
    await installOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, content })
    expect(fs.modeOf(PLUGIN_PATH)).toBe(0o600)
  })

  it('keeps the refreshed plugin owner-only too', async () => {
    const fs = new FakeHookFs()
    fs.addDir(PLUGIN_DIR)
    fs.addFile(PLUGIN_PATH, `${OPENCODE_PLUGIN_HEADER}\nold\n`)
    await installOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, content })
    expect(fs.modeOf(PLUGIN_PATH)).toBe(0o600)
  })
})

describe('uninstallOpenCodePlugin (#588 T6)', () => {
  it('removes exactly the file it wrote, and the directory only when it created that too', async () => {
    const fs = new FakeHookFs()
    await installOpenCodePlugin({
      fs,
      pluginDir: PLUGIN_DIR,
      content: `${OPENCODE_PLUGIN_HEADER}\n`
    })
    const report = await uninstallOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, removeDir: true })
    expect(report).toEqual({ path: expect.stringContaining(OPENCODE_PLUGIN_FILE), changed: true })
    expect(fs.read(PLUGIN_PATH)).toBeUndefined()
    expect(await fs.exists(PLUGIN_DIR)).toBe(false)
  })

  it('keeps a directory it created once the person has put their own plugins in it', async () => {
    const fs = new FakeHookFs()
    await installOpenCodePlugin({
      fs,
      pluginDir: PLUGIN_DIR,
      content: `${OPENCODE_PLUGIN_HEADER}\n`
    })
    fs.addFile(`${PLUGIN_DIR}/theirs.ts`, 'export const theirs = 1\n')
    await uninstallOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, removeDir: true })
    expect(fs.read(`${PLUGIN_DIR}/theirs.ts`)).toBe('export const theirs = 1\n')
    expect(await fs.exists(PLUGIN_DIR)).toBe(true)
  })

  it('never removes a directory that was already there', async () => {
    const fs = new FakeHookFs()
    fs.addDir(PLUGIN_DIR)
    await installOpenCodePlugin({
      fs,
      pluginDir: PLUGIN_DIR,
      content: `${OPENCODE_PLUGIN_HEADER}\n`
    })
    await uninstallOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, removeDir: false })
    expect(await fs.exists(PLUGIN_DIR)).toBe(true)
  })

  it('leaves a same-named file it did not write exactly as found', async () => {
    const fs = new FakeHookFs()
    fs.addDir(PLUGIN_DIR)
    fs.addFile(PLUGIN_PATH, 'export const theirs = 1\n')
    const report = await uninstallOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, removeDir: true })
    expect(report.changed).toBe(false)
    expect(fs.read(PLUGIN_PATH)).toBe('export const theirs = 1\n')
    expect(await fs.exists(PLUGIN_DIR)).toBe(true)
  })

  it('is a no-op when nothing was ever installed', async () => {
    const fs = new FakeHookFs()
    const report = await uninstallOpenCodePlugin({ fs, pluginDir: PLUGIN_DIR, removeDir: true })
    expect(report.changed).toBe(false)
  })
})
