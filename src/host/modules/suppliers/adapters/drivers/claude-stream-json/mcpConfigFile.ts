// The `--mcp-config` file of a stream-json launch (15 §4.2, ADR-013 item 3 `ticket-file`): written by
// the Host under its data directory before the spawn, it holds only the relay entry — the relay
// command, its arguments and its own env with `ELECTRON_RUN_AS_NODE=1` and the credential FILE PATH
// (`relayEntry`, 15 §4 "Delegation relay form") — never a credential value (ADR-013 item 2, ADR-017
// item 3, C-23). Owner-only: mode 0600 in a 0700 folder; never overwritten; removed when the
// session ends.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { RelayEntry } from '../shared/relayEntry'
import { PERMISSION_SERVER } from './argv'

export const MCP_CONFIG_FILE_MODE = 0o600
export const MCP_CONFIG_DIR_MODE = 0o700

/** Where the driver keeps its `--mcp-config` files: one per launch, owner-only. */
export interface McpConfigFiles {
  /** Creates `path` with `text`, owner-only; rejects when the file already exists. */
  write(path: string, text: string): Promise<void>
  /** Deletes `path`; a file already gone is not an error. */
  remove(path: string): Promise<void>
}

/** `<dir>/<launchId>.mcp.json`, joined the way the target OS joins paths. */
export function mcpConfigPath(
  dir: string,
  launchId: string,
  platform: 'win32' | 'darwin' | 'linux'
): string {
  return (platform === 'win32' ? win32 : posix).join(dir, `${launchId}.mcp.json`)
}

/** The file's whole text: one MCP server, the relay entry, and nothing else. */
export function mcpConfigText(entry: RelayEntry): string {
  const server = { command: entry.command, args: [...entry.args], env: { ...entry.env } }
  return `${JSON.stringify({ mcpServers: { [PERMISSION_SERVER]: server } }, null, 2)}\n`
}

/** The real store: `node:fs`, mode 0600 in a 0700 folder, `wx` so nothing is overwritten. */
export class NodeMcpConfigFiles implements McpConfigFiles {
  async write(path: string, text: string): Promise<void> {
    const folder = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
    await mkdir(folder, { recursive: true, mode: MCP_CONFIG_DIR_MODE })
    await writeFile(path, text, { mode: MCP_CONFIG_FILE_MODE, flag: 'wx' })
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true })
  }
}
