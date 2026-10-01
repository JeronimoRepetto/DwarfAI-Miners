// The per-OS root of the Host's versioned copies (ADR-002 D5; ADR-027 item 2): one pure rule that
// the UI (the launcher makes `host/<version>/` under it, ISSUE-031) and the Host (it accepts a
// `host.upgrade.request.targetDir` only as a direct child of it, 14 §1.10; ISSUE-032) both run,
// so both always name the same folder from the same environment (the Host inherits the UI's).
//
// - Windows: `%LOCALAPPDATA%\DwarfAI\host`;
// - macOS: `~/Library/Application Support/DwarfAI/host`;
// - Linux: `$XDG_DATA_HOME/dwarfai/host`, where an unset, empty or relative XDG_DATA_HOME means
//   `~/.local/share` (XDG Base Directory).
// Without an absolute LOCALAPPDATA (Windows) or home folder (macOS, Linux) there is no root.
import type { EndpointPlatform } from './endpoint'
import { isAbsolutePath, normaliseAbsolutePath } from './osPath'

export function versionedCopyRoot(input: {
  platform: EndpointPlatform
  env: Readonly<Record<string, string | undefined>>
  homeDir: string
}): { ok: true; value: string } | { ok: false; errCode: string } {
  const { platform } = input
  const unknown = { ok: false as const, errCode: 'COPY_ROOT_UNKNOWN' }
  const sep = platform === 'win32' ? '\\' : '/'
  const under = (base: string, ...segments: string[]): string =>
    normaliseAbsolutePath([base, ...segments].join(sep), platform)
  if (platform === 'win32') {
    const local = input.env['LOCALAPPDATA']
    if (local === undefined || !isAbsolutePath(local, platform)) return unknown
    return { ok: true, value: under(local, 'DwarfAI', 'host') }
  }
  if (!isAbsolutePath(input.homeDir, platform)) return unknown
  if (platform === 'darwin') {
    const value = under(input.homeDir, 'Library', 'Application Support', 'DwarfAI', 'host')
    return { ok: true, value }
  }
  const xdg = input.env['XDG_DATA_HOME']
  const dataHome =
    xdg !== undefined && isAbsolutePath(xdg, platform)
      ? xdg
      : under(input.homeDir, '.local', 'share')
  return { ok: true, value: under(dataHome, 'dwarfai', 'host') }
}
