// L4 (17 §1.4): the relay's MCP server entry, the 15 §4 "Delegation relay form" (ADR-013 item 3).
// TC-200-01: its argv has no credential and its env holds only the two relay variables, the
// credential file path included (C-23, INV-83).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_ENTRY_FILE, relayEntryArgs, relayServerEntry } from './relayEntry'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01'
const CREDENTIAL = 'a1'.repeat(32)
const EXEC = '/home/j/.local/share/DwarfAI-Miners/host/0.20.0/dwarfai-miners'

/** A credential file as `RunDirCredentialFileStore` writes it: `<hostDataDir>/run/mcp/<launchId>.cred`. */
function credentialFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dw200e-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'host', 'run', 'mcp')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${LAUNCH}.cred`)
  writeFileSync(path, CREDENTIAL)
  return path
}

describe('relayServerEntry (15 §4 relay form)', () => {
  it("[C-23, INV-83] the relay entry's argv holds no credential and its env holds exactly ELECTRON_RUN_AS_NODE and DWARFAI_MCP_CREDENTIAL_FILE with a path", () => {
    const path = credentialFile()
    const entry = relayServerEntry({
      appPaths: { execPath: EXEC },
      relayEntryArgs: relayEntryArgs('/app/resources/app.asar/out/host/main.js'),
      credentialFilePath: path
    })

    expect([entry.command, ...entry.args].join(' ')).not.toContain(CREDENTIAL)
    expect(Object.keys(entry.env).sort()).toEqual([
      'DWARFAI_MCP_CREDENTIAL_FILE',
      'ELECTRON_RUN_AS_NODE'
    ])
    expect(entry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', DWARFAI_MCP_CREDENTIAL_FILE: path })
    expect(JSON.stringify(entry)).not.toContain(CREDENTIAL)
    // A value where the path belongs is refused: only an absolute file path crosses (C-15).
    expect(() =>
      relayServerEntry({
        appPaths: { execPath: EXEC },
        relayEntryArgs: ['/app/out/host/dwarfai-mcp.js'],
        credentialFilePath: CREDENTIAL
      })
    ).toThrow(/path/)
  })

  it('[C-23] the command is the versioned-copy executable from AppPaths.execPath', () => {
    const entry = relayServerEntry({
      appPaths: { execPath: EXEC },
      relayEntryArgs: relayEntryArgs('/app/resources/app.asar/out/host/main.js'),
      credentialFilePath: credentialFile()
    })

    expect(entry.command).toBe(EXEC)
    // The relay entry ships beside the Host entry (electron.vite.host.config.ts).
    expect(entry.args).toEqual([join('/app/resources/app.asar/out/host', RELAY_ENTRY_FILE)])
    expect(RELAY_ENTRY_FILE).toBe('dwarfai-mcp.js')
  })
})
