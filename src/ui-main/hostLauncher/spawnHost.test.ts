// Where the Host's executable and entry are inside the versioned copy (ADR-002 D5; SP-03).
import { describe, expect, it } from 'vitest'
import {
  hostEnvironment,
  hostSpawnInputFromCopy,
  withDotenvEntries,
  type HostSpawnInput
} from './spawnHost'

const WINDOWS_HOST: HostSpawnInput = {
  execPath: 'C:\\Apps\\DwarfAI-Miners\\DwarfAI-Miners.exe',
  hostEntry: 'C:\\Apps\\DwarfAI-Miners\\resources\\app.asar\\out\\host\\main.js',
  hostDataDir: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host',
  uiEnv: {}
}

describe('hostSpawnInputFromCopy (ADR-002 D5)', () => {
  it('[ADR-002, SP-03] the executable and a packaged entry are taken at the same place inside the copy', () => {
    expect(
      hostSpawnInputFromCopy(WINDOWS_HOST, {
        sourceDir: 'C:\\Apps\\DwarfAI-Miners',
        contentDir: 'C:\\Users\\j\\AppData\\Local\\DwarfAI\\host\\1.4.0'
      })
    ).toEqual({
      ok: true,
      value: {
        ...WINDOWS_HOST,
        execPath: 'C:\\Users\\j\\AppData\\Local\\DwarfAI\\host\\1.4.0\\DwarfAI-Miners.exe',
        hostEntry:
          'C:\\Users\\j\\AppData\\Local\\DwarfAI\\host\\1.4.0\\resources\\app.asar\\out\\host\\main.js'
      }
    })
    expect(
      hostSpawnInputFromCopy(
        {
          ...WINDOWS_HOST,
          execPath: '/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners',
          hostEntry: '/Applications/DwarfAI-Miners.app/Contents/Resources/app.asar/out/host/main.js'
        },
        {
          sourceDir: '/Applications/DwarfAI-Miners.app',
          contentDir: '/Users/j/Library/Application Support/DwarfAI/host/1.4.0/DwarfAI-Miners.app'
        }
      )
    ).toMatchObject({
      ok: true,
      value: {
        execPath:
          '/Users/j/Library/Application Support/DwarfAI/host/1.4.0/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners'
      }
    })
  })

  it('[ADR-002] an entry outside the copied directory (a development build) stays where it is, run by the copied executable', () => {
    const outcome = hostSpawnInputFromCopy(
      {
        ...WINDOWS_HOST,
        execPath: '/repo/node_modules/electron/dist/electron',
        hostEntry: '/repo/out/host/main.js'
      },
      {
        sourceDir: '/repo/node_modules/electron/dist',
        contentDir: '/home/j/.local/share/dwarfai/host/0.13.1'
      }
    )
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        execPath: '/home/j/.local/share/dwarfai/host/0.13.1/electron',
        hostEntry: '/repo/out/host/main.js'
      }
    })
  })

  it('[ADR-002, ADR-027] an executable outside the copied directory is refused: the Host never runs from the install folder', () => {
    expect(
      hostSpawnInputFromCopy(WINDOWS_HOST, {
        sourceDir: 'C:\\Apps\\Other',
        contentDir: 'C:\\Users\\j\\AppData\\Local\\DwarfAI\\host\\1.4.0'
      })
    ).toEqual({ ok: false, errCode: 'EXEC_OUTSIDE_COPY' })
    // A sibling folder whose name starts with the source's is not inside it.
    expect(
      hostSpawnInputFromCopy(
        { ...WINDOWS_HOST, execPath: 'C:\\Apps\\DwarfAI-Miners-old\\DwarfAI-Miners.exe' },
        { sourceDir: 'C:\\Apps\\DwarfAI-Miners', contentDir: 'C:\\copy' }
      )
    ).toEqual({ ok: false, errCode: 'EXEC_OUTSIDE_COPY' })
  })
})

// A development checkout's settings live in the repo `.env`, which UI main's legacy composition loads
// into its own environment only after the Host is started (the attach starts before Electron is
// ready). The launcher layers it under the Host's environment as dotenv layers it under UI main's:
// a variable the environment already has wins (HO-09; `contracts/config`, #38).
describe('withDotenvEntries (the repo .env reaches the Host)', () => {
  it('[FM-091] a .env setting the UI environment lacks reaches the Host environment; one it has keeps the environment value', () => {
    const env = withDotenvEntries(
      { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/data/claude' },
      { CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work', CLAUDE_CONFIG_DIR: '/elsewhere' }
    )
    const host = hostEnvironment(env, '/home/j/.config/DwarfAI-Miners/host')
    expect(host['CLAUDE_CONFIG_DIRS']).toBe('~/.claude;~/.claude-work')
    expect(host['CLAUDE_CONFIG_DIR']).toBe('/data/claude')
    expect(host['PATH']).toBe('/usr/bin')
  })

  it('[FM-091, NFR-SEC-05] a DWARFAI_ name in the .env never reaches the Host: the launcher alone sets those', () => {
    const env = withDotenvEntries({}, { DWARFAI_HOST_DATA_DIR: '/tmp/x', DWARFAI_TOKEN: 't' })
    const host = hostEnvironment(env, '/data/host')
    expect(host['DWARFAI_HOST_DATA_DIR']).toBe('/data/host')
    expect(host['DWARFAI_TOKEN']).toBeUndefined()
  })
})
