// layer: L2
// The Claude configuration roots the Host observes (HO-09; FM-091, FM-093): the shipped setting
// CLAUDE_CONFIG_DIRS (`contracts/config` `ClaudeConfig.configDirs`), read from the Host's environment
// and, under it, from the userData config file (`config-v1.json`) as the shipped layering reads it;
// else CLAUDE_CONFIG_DIR, else `~/.claude`. Every Claude consumer of the Host reads the same list.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { CLAUDE_CONFIG_DIRS_KEY } from '@dwarfai/contracts'
import { observedProviderFolders, readHostSettings } from './observation'

const HOME = join('/home', 'j')
const CONFIG_FILE = join('/data', 'DwarfAI-Miners', 'config-v1.json')

describe('the Claude roots the Host observes (CLAUDE_CONFIG_DIRS)', () => {
  it('[FM-091] the environment list is every Claude root, its ~ expanded; the hooks root stays CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    const folders = observedProviderFolders(
      { CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work' },
      HOME
    )
    expect(folders.claudeConfigDirs).toEqual([join(HOME, '.claude'), join(HOME, '.claude-work')])
    expect(folders.claudeConfigDir).toBe(join(HOME, '.claude'))
  })

  it('[FM-091] with no list the one root is CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    const custom = join('/data', 'claude')
    expect(observedProviderFolders({ CLAUDE_CONFIG_DIR: custom }, HOME).claudeConfigDirs).toEqual([
      custom
    ])
    expect(observedProviderFolders({}, HOME).claudeConfigDirs).toEqual([join(HOME, '.claude')])
  })

  it('[FM-091] an invalid list falls back to the one root and says which key, never failing the Host', () => {
    const invalid: string[] = []
    const folders = observedProviderFolders({ CLAUDE_CONFIG_DIRS: ' ; ' }, HOME, {
      onInvalid: (key) => invalid.push(key)
    })
    expect(folders.claudeConfigDirs).toEqual([join(HOME, '.claude')])
    expect(invalid).toEqual([CLAUDE_CONFIG_DIRS_KEY])
  })

  it('[FM-091] the Host reads the list from the userData config file under a blank environment, and the environment over it', async () => {
    const fs = new FakeFs()
    fs.addFile(CONFIG_FILE, '{"CLAUDE_CONFIG_DIRS":"~/.claude;~/.claude-work"}')

    const fromFile = await readHostSettings({ CLAUDE_CONFIG_DIRS: '' }, fs, CONFIG_FILE)
    expect(observedProviderFolders({}, HOME, { settings: fromFile }).claudeConfigDirs).toEqual([
      join(HOME, '.claude'),
      join(HOME, '.claude-work')
    ])

    const env = { CLAUDE_CONFIG_DIRS: join('/data', 'claude') }
    const fromEnv = await readHostSettings(env, fs, CONFIG_FILE)
    expect(observedProviderFolders(env, HOME, { settings: fromEnv }).claudeConfigDirs).toEqual([
      join('/data', 'claude')
    ])

    // No file, or a malformed one: no entries, the environment and the defaults alone.
    const none = await readHostSettings({}, new FakeFs(), CONFIG_FILE)
    expect(observedProviderFolders({}, HOME, { settings: none }).claudeConfigDirs).toEqual([
      join(HOME, '.claude')
    ])
    const broken = new FakeFs()
    broken.addFile(CONFIG_FILE, '{not json')
    const malformed = await readHostSettings({}, broken, CONFIG_FILE)
    expect(observedProviderFolders({}, HOME, { settings: malformed }).claudeConfigDirs).toEqual([
      join(HOME, '.claude')
    ])
  })
})
