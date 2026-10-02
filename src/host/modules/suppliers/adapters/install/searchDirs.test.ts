import { describe, expect, it } from 'vitest'
import {
  executableNames,
  overridePath,
  packageManagerDirs,
  pathDirs,
  probeEnv,
  type HostEnv
} from './searchDirs'

describe('resolver search directories (ADR-009 D5)', () => {
  it('[ADR-009] a Windows binary is looked for with every PATHEXT extension, and a bare name is never a Windows program', () => {
    expect(executableNames('codex', { PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toEqual([
      'codex.com',
      'codex.exe',
      'codex.bat',
      'codex.cmd'
    ])
    expect(executableNames('codex.exe', { PATHEXT: '.EXE;.CMD' }, 'win32')).toEqual(['codex.exe'])
    // PATHEXT missing: the Windows default.
    expect(executableNames('codex', {}, 'win32')).toEqual([
      'codex.com',
      'codex.exe',
      'codex.bat',
      'codex.cmd'
    ])
    expect(executableNames('codex', { PATHEXT: '.EXE' }, 'linux')).toEqual(['codex'])
  })

  it('[ADR-009] PATH splits per OS, without empty entries or surrounding quotes', () => {
    expect(pathDirs('C:\\a;;"C:\\Program Files\\b";', 'win32')).toEqual([
      'C:\\a',
      'C:\\Program Files\\b'
    ])
    expect(pathDirs('/usr/bin::/opt/x/bin', 'darwin')).toEqual(['/usr/bin', '/opt/x/bin'])
    expect(pathDirs(undefined, 'linux')).toEqual([])
  })

  it('[ADR-009] the known package-manager directories of each OS, honouring each manager variable', () => {
    const home = 'C:\\Users\\j'
    const env: HostEnv = {
      APPDATA: 'C:\\Users\\j\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local'
    }
    expect(packageManagerDirs(env, home, 'win32').map((d) => d.dir)).toEqual([
      'C:\\Users\\j\\AppData\\Roaming\\npm',
      'C:\\Users\\j\\AppData\\Local\\pnpm',
      'C:\\Users\\j\\AppData\\Local\\Volta\\bin',
      'C:\\Users\\j\\.bun\\bin',
      'C:\\Users\\j\\scoop\\shims',
      'C:\\Users\\j\\AppData\\Local\\Microsoft\\WinGet\\Links'
    ])
    expect(
      packageManagerDirs(
        { PNPM_HOME: '/data/pnpm', VOLTA_HOME: '/data/volta' },
        '/home/j',
        'linux'
      ).map((d) => d.dir)
    ).toEqual([
      '/home/j/.npm-global/bin',
      '/usr/local/bin',
      '/data/pnpm',
      '/data/volta/bin',
      '/home/j/.bun/bin'
    ])
    expect(packageManagerDirs({}, '/Users/j', 'darwin').map((d) => d.dir)).toEqual([
      '/Users/j/.npm-global/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/Users/j/Library/pnpm',
      '/Users/j/.volta/bin',
      '/Users/j/.bun/bin'
    ])
  })

  it('[ADR-009] DWARFAI_AGY_PATH names agy only, and a probe child never inherits it nor any variable outside the allowlist', () => {
    const env: HostEnv = {
      dwarfai_agy_path: 'D:\\agy.exe',
      Path: 'C:\\a',
      SystemRoot: 'C:\\Windows',
      OPENAI_API_KEY: 'never'
    }
    expect(overridePath('agy', env, 'win32')).toBe('D:\\agy.exe')
    expect(overridePath('codex', env, 'win32')).toBeNull()
    expect(overridePath('agy', { DWARFAI_AGY_PATH: '  ' }, 'linux')).toBeNull()

    expect(probeEnv(env, 'win32')).toEqual({ PATH: 'C:\\a', SystemRoot: 'C:\\Windows' })
    expect(probeEnv({ HOME: '/home/j', DWARFAI_AGY_PATH: '/x', TOKEN: 't' }, 'linux')).toEqual({
      HOME: '/home/j'
    })
  })
})
