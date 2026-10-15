// L8 OS lane (17 §1.8; 15 §4.2, ADR-013 item 3): the real `--mcp-config` file store on disk. On every
// OS it creates the file once, never overwrites one and removes it; on POSIX the file is 0600 in a
// 0700 folder. Windows has no file modes (the file inherits the Host data folder's ACL, SP-05), so
// the mode case runs on macOS and Linux only.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { relayEntry } from '../shared/relayEntry'
import { mcpConfigText, NodeMcpConfigFiles } from './mcpConfigFile'

const POSIX = process.platform !== 'win32'

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-150-mcp-'))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function text(root: string): string {
  return mcpConfigText(
    relayEntry({
      command: join(root, 'dwarfai'),
      args: ['dwarfai-mcp-relay'],
      credentialFilePath: join(root, 'run', 'mcp', 'launch-1.cred'),
      platform: process.platform
    })
  )
}

describe.runIf(!POSIX)('the --mcp-config file store on Windows (ADR-013 item 3)', () => {
  it('[C-23] the mcp-config file is written once, never overwritten, and removed', async () => {
    await withRoot(async (root) => {
      const files = new NodeMcpConfigFiles()
      const path = join(root, 'run', 'mcp', 'launch-1.mcp.json')
      await files.write(path, text(root))
      expect(readFileSync(path, 'utf8')).toBe(text(root))
      await expect(files.write(path, '{}')).rejects.toThrow()
      await files.remove(path)
      await files.remove(path)
      expect(() => statSync(path)).toThrow()
    })
  })
})

describe.runIf(POSIX)('the --mcp-config file store on POSIX (ADR-013 item 3)', () => {
  it('[C-23] the mcp-config file is 0600 in a 0700 folder, never overwritten, and removed', async () => {
    await withRoot(async (root) => {
      const files = new NodeMcpConfigFiles()
      const folder = join(root, 'run', 'mcp')
      const path = join(folder, 'launch-1.mcp.json')
      await files.write(path, text(root))
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(folder).mode & 0o777).toBe(0o700)
      await expect(files.write(path, '{}')).rejects.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(text(root))
      await files.remove(path)
      await files.remove(path)
      expect(() => statSync(path)).toThrow()
    })
  })
})
