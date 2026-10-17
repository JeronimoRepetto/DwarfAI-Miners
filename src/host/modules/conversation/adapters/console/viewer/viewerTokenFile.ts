// The content of a per-view token file `<hostDataDir>/run/viewers/<viewId>.token` (ADR-003 item 12):
// written by the Host (HostConsoleResolver), read once and deleted by the viewer before its `hello`.
//
// Package gap (ADR-003 item 12 names the file and that it holds the token, not its layout): two
// lines, the token's 64 lower-case hex digits, then the `dwarfId` it is bound to. The viewer needs
// the `dwarfId` for `conversation.feed {dwarfId}` (B-M26, its own dwarf only), and it is not a
// secret; the token stays the only credential, and it is never in argv or an environment variable.
// Anything else is refused whole.

/** The most of the file the viewer reads: 64 + 1 + 36 + 1 bytes fit, nothing much longer does. */
export const VIEWER_TOKEN_FILE_MAX_BYTES = 256

export interface ViewerTokenFile {
  token: string
  dwarfId: string
}

const TOKEN = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function formatViewerTokenFile(file: ViewerTokenFile): string {
  return `${file.token}\n${file.dwarfId}\n`
}

/** The token and dwarf of a file's text, or null when it is not exactly the two lines. */
export function parseViewerTokenFile(text: string): ViewerTokenFile | null {
  const lines = text.split('\n')
  if (lines.length !== 3 || lines[2] !== '') return null
  const [token = '', dwarfId = ''] = lines
  return TOKEN.test(token) && UUID.test(dwarfId) ? { token, dwarfId } : null
}
