// The delegation relay form of `15` §4 (frozen; ADR-013 item 3): the Jev MCP entry runs the
// Host's versioned-copy executable with the relay entry argument, and its OWN `env` holds exactly
// `ELECTRON_RUN_AS_NODE=1` and `DWARFAI_MCP_CREDENTIAL_FILE=<path>`. That env is the only place
// these two variables appear; `childEnv` keeps both out of the provider child (R5B-14). The
// credential travels as a file path, never as its value (ADR-013 item 2, ADR-017 item 3).
import { posix, win32 } from 'node:path'
import { HostInvariantError } from '../../../../../kernel/domain/errors'

export interface RelayEntry {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export function relayEntry(input: {
  command: string
  args: readonly string[]
  credentialFilePath: string
  platform: NodeJS.Platform
}): RelayEntry {
  const paths = input.platform === 'win32' ? win32 : posix
  if (input.credentialFilePath === '' || !paths.isAbsolute(input.credentialFilePath)) {
    throw new HostInvariantError('the relay entry carries the credential file path, never a value')
  }
  return {
    command: input.command,
    args: [...input.args],
    env: { ELECTRON_RUN_AS_NODE: '1', DWARFAI_MCP_CREDENTIAL_FILE: input.credentialFilePath }
  }
}
