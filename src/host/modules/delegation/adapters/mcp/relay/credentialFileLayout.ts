// The credential file's layout (ADR-013 items 2–3; foreman decision 2026-10-18, owner-approved in
// place of the rejected AMENDMENT-24): what the Host writes to `<hostDataDir>/run/mcp/<launchId>.cred`
// and what the relay reads from it. Pure; shared by the Host side (EndpointNamingCredentialFiles.ts)
// and the relay (relayMain.ts), so the two never drift.
//
// - Layout 1 (today's): `{"v":1,"credential":"<64 lower-case hex>","endpoint":"<MCP endpoint path>"}`,
//   exactly the bytes `JSON.stringify` writes for those three members in that order: no other
//   member, no whitespace, no line end. The Host names the endpoint it bound, so the relay never
//   derives it from its own environment (a provider that drops XDG_RUNTIME_DIR from its stdio MCP
//   servers made the relay name the fallback socket while the Host bound the XDG one, CI run
//   39109490095). The relay still checks the endpoint against the Host's own rule (relayMain.ts).
// - The legacy layout: the credential alone (64 lower-case hex). A relay of this build reading a
//   file a Host of the previous build wrote derives the endpoint as before, so a running session
//   survives an upgrade; the Host writes it only when it has no bound endpoint to name.
// - Anything else, or more than MAX_CREDENTIAL_FILE_BYTES, is not a credential file.

/**
 * The most of the credential file the relay reads, in bytes: layout 1 with the longest endpoint
 * (a socket path fits `sun_path`, 108 bytes on Linux, 104 on macOS, every byte doubled at worst
 * by JSON escaping; a pipe name is about 50) and the 64-byte credential stays under it.
 */
export const MAX_CREDENTIAL_FILE_BYTES = 512

const CREDENTIAL = /^[0-9a-f]{64}$/
const LAYOUT_VERSION = 1

export interface CredentialFileContent {
  credential: string
  /** The endpoint the Host bound, or null for the legacy layout (the relay derives it). */
  endpoint: string | null
}

/**
 * The file's content for `credential` and the endpoint the Host bound: layout 1, or the legacy
 * layout when no endpoint is known or layout 1 would not fit MAX_CREDENTIAL_FILE_BYTES.
 */
export function credentialFileContent(credential: string, endpoint: string | null): string {
  if (endpoint === null || endpoint === '') return credential
  const content = layoutOf(credential, endpoint)
  return Buffer.byteLength(content, 'utf8') <= MAX_CREDENTIAL_FILE_BYTES ? content : credential
}

/** The content of a credential file, or null when the text is not one. */
export function parseCredentialFile(text: string): CredentialFileContent | null {
  if (Buffer.byteLength(text, 'utf8') > MAX_CREDENTIAL_FILE_BYTES) return null
  if (CREDENTIAL.test(text)) return { credential: text, endpoint: null }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { v, credential, endpoint } = value as Record<string, unknown>
  if (v !== LAYOUT_VERSION || typeof credential !== 'string' || typeof endpoint !== 'string') {
    return null
  }
  if (!CREDENTIAL.test(credential) || endpoint === '') return null
  // Byte for byte the layout the Host writes: no other member, order, spacing or escape form.
  return text === layoutOf(credential, endpoint) ? { credential, endpoint } : null
}

function layoutOf(credential: string, endpoint: string): string {
  return JSON.stringify({ v: LAYOUT_VERSION, credential, endpoint })
}
