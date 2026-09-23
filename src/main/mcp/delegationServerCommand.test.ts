import { describe, expect, it } from 'vitest'
import {
  resolveDelegationServerCommand,
  resolveDelegationServerScriptPath,
  type DelegationServerPathOptions
} from './delegationServerCommand'

/**
 * Where `jevMcpServer.mjs` lives at runtime, and how to spawn it (#511 T4) —
 * pure, so dev/packaged and all three OS path styles are asserted on any
 * host (`platform-ports`). The packaged answer resolves under
 * `app.asar.unpacked`: see this module's own top comment for the asar
 * decision and why no authoritative evidence was found for the alternative.
 */

const WIN_PACKAGED: DelegationServerPathOptions = {
  isPackaged: true,
  resourcesPath: 'C:\\Program Files\\DwarfAI-Miners\\resources',
  appPath: 'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar'
}

const WIN_DEV: DelegationServerPathOptions = {
  isPackaged: false,
  resourcesPath: '',
  appPath: 'C:\\Users\\j\\DwarfAI-Miners'
}

const POSIX_PACKAGED: DelegationServerPathOptions = {
  isPackaged: true,
  resourcesPath: '/Applications/DwarfAI-Miners.app/Contents/Resources',
  appPath: '/Applications/DwarfAI-Miners.app/Contents/Resources/app.asar'
}

const POSIX_DEV: DelegationServerPathOptions = {
  isPackaged: false,
  resourcesPath: '',
  appPath: '/home/j/DwarfAI-Miners'
}

describe('resolveDelegationServerScriptPath', () => {
  it('resolves under app.asar.unpacked when packaged, on Windows', () => {
    expect(resolveDelegationServerScriptPath(WIN_PACKAGED, 'win32')).toBe(
      'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar.unpacked\\out\\main\\jevMcpServer.mjs'
    )
  })

  it('resolves alongside out/main at the project root when in dev, on Windows', () => {
    expect(resolveDelegationServerScriptPath(WIN_DEV, 'win32')).toBe(
      'C:\\Users\\j\\DwarfAI-Miners\\out\\main\\jevMcpServer.mjs'
    )
  })

  it('resolves under app.asar.unpacked when packaged, on macOS/Linux', () => {
    expect(resolveDelegationServerScriptPath(POSIX_PACKAGED, 'darwin')).toBe(
      '/Applications/DwarfAI-Miners.app/Contents/Resources/app.asar.unpacked/out/main/jevMcpServer.mjs'
    )
    expect(resolveDelegationServerScriptPath(POSIX_PACKAGED, 'linux')).toBe(
      '/Applications/DwarfAI-Miners.app/Contents/Resources/app.asar.unpacked/out/main/jevMcpServer.mjs'
    )
  })

  it('resolves alongside out/main at the project root when in dev, on macOS/Linux', () => {
    expect(resolveDelegationServerScriptPath(POSIX_DEV, 'darwin')).toBe(
      '/home/j/DwarfAI-Miners/out/main/jevMcpServer.mjs'
    )
  })

  it('never reads process.platform itself — the caller always names one', () => {
    // Passing the OPPOSITE platform's own separator convention against a
    // Windows host process proves the function takes the parameter rather
    // than asking the OS, the same proof platformAdapters.test.ts holds
    // every per-OS builder to.
    expect(resolveDelegationServerScriptPath(POSIX_DEV, 'linux')).not.toContain('\\')
    expect(resolveDelegationServerScriptPath(WIN_DEV, 'win32')).not.toContain('/')
  })
})

describe('resolveDelegationServerCommand', () => {
  it('spawns the host Electron binary as the command, with the resolved script as its one argv element', () => {
    const execPath = 'C:\\Program Files\\DwarfAI-Miners\\DwarfAI-Miners.exe'
    expect(resolveDelegationServerCommand(WIN_PACKAGED, execPath, 'win32')).toEqual({
      command: execPath,
      args: [
        'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar.unpacked\\out\\main\\jevMcpServer.mjs'
      ]
    })
  })

  it('carries the dev script path when not packaged', () => {
    const execPath = '/home/j/.local/share/electron/electron'
    expect(resolveDelegationServerCommand(POSIX_DEV, execPath, 'linux')).toEqual({
      command: execPath,
      args: ['/home/j/DwarfAI-Miners/out/main/jevMcpServer.mjs']
    })
  })
})
