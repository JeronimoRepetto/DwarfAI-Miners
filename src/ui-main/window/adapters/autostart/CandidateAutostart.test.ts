// layer: L3
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runCandidateLoginEntryContract,
  type CandidateLoginEntrySubject
} from '../../ports/candidateLoginEntry.contract'
import {
  CANDIDATE_RUN_KEY,
  candidateDefaultMarkerAt,
  candidateLoginEntryFor,
  launchAgentPlistPath,
  xdgAutostartPath,
  type CandidateAutostartFs
} from './CandidateAutostart'

/**
 * `CandidateAutostart` on each OS over a model of what that OS keeps (17 §1.3), transplanted from
 * `src/main/platform/autostartPorts.test.ts` and `platformAdapters.test.ts` (17 §2.5) with the expectations unchanged:
 * the `reg.exe` calls on Windows, the LaunchAgent plist on macOS, the XDG entry on Linux.
 */
const PACKAGED = { executable: '/opt/DwarfAI-Miners/dwarfai-miners', args: [] }
const WINDOWS_APP = { executable: 'C:\\Apps\\DwarfAI-Miners.exe', args: [] }

/** The Run key as `reg.exe` sees it: `query` and `delete` of a missing value fail, as the real command does. */
class RunKeyModel {
  readonly values = new Map<string, string>()
  readonly calls: string[][] = []
  refuse = false

  readonly run = async (args: string[]): Promise<void> => {
    this.calls.push(args)
    const [verb, key, , name] = args
    if (key !== CANDIDATE_RUN_KEY || name === undefined) throw new Error('reg: wrong key')
    if (verb === 'query') {
      if (!this.values.has(name)) throw new Error('reg: value not found')
      return
    }
    if (this.refuse) throw Object.assign(new Error('reg: access denied'), { code: 'EACCES' })
    if (verb === 'add') {
      this.values.set(name, args[args.indexOf('/d') + 1] ?? '')
      return
    }
    if (verb === 'delete') {
      if (!this.values.delete(name)) throw new Error('reg: value not found')
      return
    }
    throw new Error(`reg: ${verb}`)
  }
}

/** The files the macOS and Linux entries write. */
function filesModel(): CandidateAutostartFs & { files: Map<string, string>; refuse: boolean } {
  const model = {
    files: new Map<string, string>(),
    refuse: false,
    async writeFile(path: string, content: string) {
      if (model.refuse) throw Object.assign(new Error('read-only volume'), { code: 'EROFS' })
      model.files.set(path, content)
    }
  }
  return model
}

runCandidateLoginEntryContract('CandidateAutostart on Windows', (): CandidateLoginEntrySubject => {
  const reg = new RunKeyModel()
  return {
    entry: candidateLoginEntryFor({
      platform: 'win32',
      command: WINDOWS_APP,
      home: 'C:\\Users\\j',
      env: {},
      reg: reg.run
    }),
    starts: async () => reg.values.has('DwarfAI-Miners'),
    refuseWrites: () => (reg.refuse = true),
    seedLegacy: () => void reg.values.set('AgentName', '"C:\\Old\\AgentName.exe"'),
    legacy: async () => reg.values.has('AgentName')
  }
})

for (const platform of ['darwin', 'linux'] as const) {
  runCandidateLoginEntryContract(`CandidateAutostart on ${platform}`, () => {
    const fs = filesModel()
    const home = platform === 'darwin' ? '/Users/j' : '/home/j'
    return {
      entry: candidateLoginEntryFor({
        platform,
        command: PACKAGED,
        home,
        env: {},
        reg: async () => {
          throw new Error('no registry here')
        },
        fs
      }),
      starts: async () => fs.files.size === 1,
      refuseWrites: () => (fs.refuse = true)
    }
  })
}

describe('CandidateAutostart per OS (21 §2 cut 1)', () => {
  it('[ADR-027] on Windows enable writes the DwarfAI-Miners Run value with the quoted executable', async () => {
    const reg = new RunKeyModel()
    const entry = candidateLoginEntryFor({
      platform: 'win32',
      command: WINDOWS_APP,
      home: 'C:\\Users\\j',
      env: {},
      reg: reg.run
    })

    await entry.enable()

    expect(reg.calls).toEqual([
      [
        'add',
        CANDIDATE_RUN_KEY,
        '/v',
        'DwarfAI-Miners',
        '/t',
        'REG_SZ',
        '/d',
        '"C:\\Apps\\DwarfAI-Miners.exe"',
        '/f'
      ]
    ])
    expect(CANDIDATE_RUN_KEY).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')
  })

  it('[ADR-027] on Windows the migration removes AgentName and writes DwarfAI-Miners when AgentName was there', async () => {
    const reg = new RunKeyModel()
    reg.values.set('AgentName', '"C:\\Old\\AgentName.exe"')
    const entry = candidateLoginEntryFor({
      platform: 'win32',
      command: WINDOWS_APP,
      home: 'C:\\Users\\j',
      env: {},
      reg: reg.run
    })

    await entry.migrateLegacy()

    expect(reg.calls.map((args) => `${args[0]} ${args[3]}`)).toEqual([
      'query AgentName',
      'delete AgentName',
      'add DwarfAI-Miners'
    ])
  })

  it('[ADR-027] on Windows a person with no AgentName value is left as they were', async () => {
    const reg = new RunKeyModel()
    const entry = candidateLoginEntryFor({
      platform: 'win32',
      command: WINDOWS_APP,
      home: 'C:\\Users\\j',
      env: {},
      reg: reg.run
    })

    await entry.migrateLegacy()

    expect(reg.calls.map((args) => args[0])).toEqual(['query'])
  })

  it('[ADR-027] on Windows a migration whose write fails rejects', async () => {
    const reg = new RunKeyModel()
    reg.values.set('AgentName', '"C:\\Old\\AgentName.exe"')
    reg.refuse = true
    const entry = candidateLoginEntryFor({
      platform: 'win32',
      command: WINDOWS_APP,
      home: 'C:\\Users\\j',
      env: {},
      reg: reg.run
    })

    await expect(entry.migrateLegacy()).rejects.toThrow('access denied')
  })

  it('[ADR-027] on macOS enable writes the LaunchAgent plist and the migration writes nothing', async () => {
    const fs = filesModel()
    const entry = candidateLoginEntryFor({
      platform: 'darwin',
      command: {
        executable: '/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners',
        args: []
      },
      home: '/Users/j',
      env: {},
      reg: async () => {},
      fs
    })

    await entry.migrateLegacy()
    expect(fs.files.size).toBe(0)
    await entry.enable()

    const plist = fs.files.get(
      '/Users/j/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist'
    )
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain(
      '<string>/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners</string>'
    )
  })

  it('[ADR-027] on Linux enable writes the XDG autostart entry, following XDG_CONFIG_HOME', async () => {
    const fs = filesModel()
    const entry = candidateLoginEntryFor({
      platform: 'linux',
      command: PACKAGED,
      home: '/home/j',
      env: { XDG_CONFIG_HOME: '/home/j/cfg' },
      reg: async () => {},
      fs
    })

    await entry.enable()

    expect([...fs.files.keys()]).toEqual(['/home/j/cfg/autostart/dwarfai-miners.desktop'])
    expect(fs.files.get('/home/j/cfg/autostart/dwarfai-miners.desktop')).toContain(
      'Exec=/opt/DwarfAI-Miners/dwarfai-miners'
    )
  })

  it('[ADR-027] the entry paths: the per-user LaunchAgents folder, and ~/.config/autostart unless XDG_CONFIG_HOME is absolute', () => {
    expect(launchAgentPlistPath('/Users/j')).toBe(
      '/Users/j/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist'
    )
    expect(xdgAutostartPath('/home/j', {})).toBe('/home/j/.config/autostart/dwarfai-miners.desktop')
    expect(xdgAutostartPath('/home/j', { XDG_CONFIG_HOME: '/home/j/cfg' })).toBe(
      '/home/j/cfg/autostart/dwarfai-miners.desktop'
    )
    expect(xdgAutostartPath('/home/j', { XDG_CONFIG_HOME: 'cfg' })).toBe(
      '/home/j/.config/autostart/dwarfai-miners.desktop'
    )
  })
})

describe('the candidate default marker (21 §2 cut 1)', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('[ADR-027] the marker file is absent until written, holds autostart-default-v1, and is never written twice', async () => {
    dir = await mkdtemp(join(tmpdir(), 'candidate-marker-'))
    const path = join(dir, 'autostart-default-v1.marker')
    const marker = candidateDefaultMarkerAt(path)

    expect(await marker.exists()).toBe(false)
    await marker.write()

    expect(await marker.exists()).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('autostart-default-v1\n')
    await expect(marker.write()).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
