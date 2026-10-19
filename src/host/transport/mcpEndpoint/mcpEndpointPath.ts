// The MCP endpoint's path (ADR-013 item 3, frozen): the ADR-002 D2 pattern of the UI endpoint with
// `mcp` in place of `host`, so it carries the same `profileKey` (a dev or E2E Host has its own MCP
// endpoint too) and the same path-length limits.
// - Windows: `\\.\pipe\dwarfai-mcp-<sha256(userSid)[0..16]>-<profileKey>`;
// - macOS: `~/Library/Application Support/<app>/run/mcp-<profileKey>.sock`;
// - Linux: `$XDG_RUNTIME_DIR/dwarfai/mcp-<profileKey>.sock`, fallback
//   `<hostDataDir>/run/mcp-<profileKey>.sock`.
// Derived from `endpointFor` (contracts, the one ADR-002 D2 rule) so the two never drift: the
// last segment `dwarfai-host-…` / `host-….sock` is renamed, nothing else changes. Pure.
import {
  checkSocketPathLength,
  endpointFor,
  type EndpointInput,
  type EndpointResult,
  type HostEndpoint
} from '@dwarfai/contracts'

const PIPE_PREFIX = '\\\\.\\pipe\\dwarfai-host-'
const SOCKET_PREFIX = '/host-'

export function mcpEndpointFor(input: EndpointInput): EndpointResult<HostEndpoint> {
  const ui = endpointFor(input)
  if (!ui.ok) return ui
  const endpoint = ui.value
  if (endpoint.kind === 'named-pipe') {
    const suffix = endpoint.path.slice(PIPE_PREFIX.length)
    return { ok: true, value: { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-mcp-${suffix}` } }
  }
  const at = endpoint.path.lastIndexOf(SOCKET_PREFIX)
  const path = `${endpoint.path.slice(0, at)}/mcp-${endpoint.path.slice(at + SOCKET_PREFIX.length)}`
  const platform = input.platform === 'darwin' ? 'darwin' : 'linux'
  const fits = checkSocketPathLength(platform, path)
  if (!fits.ok) return fits
  return { ok: true, value: { kind: 'unix-socket', path, dir: endpoint.dir } }
}
