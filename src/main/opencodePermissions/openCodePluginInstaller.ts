import { posix, win32 } from 'node:path'
import type { HookFsLike } from '../hooks/hookFs'
import type { Platform } from '../platform/platform'
import pluginSource from './opencodePermissionPlugin.ts?raw'

/**
 * Writing the OpenCode permission plugin into the person's own OpenCode
 * configuration, and taking it out again (#588 T6).
 *
 * The file written is `opencodePermissionPlugin.ts`'s own SOURCE, imported
 * raw rather than compiled: OpenCode transpiles a `.ts` plugin itself
 * (docs/opencode-format.md Row 15), so the bytes on disk are the bytes the
 * artifact's own tests run, with two placeholders replaced. Nothing here
 * builds a second copy of the plugin that could drift from the tested one.
 *
 * Ownership is the first line of the file, `OPENCODE_PLUGIN_HEADER`, the same
 * substring-identity rule `HOOK_MARKER` holds for Claude's hook entries: a
 * file at our path that does not start with it belongs to somebody else and
 * is never overwritten or deleted.
 */

/** The artifact's source text, exactly as its own tests exercise it. */
export const openCodePluginSource: string = pluginSource

/**
 * The file name inside OpenCode's global plugin directory. `.ts` because the
 * artifact is TypeScript and OpenCode loads `.ts` at global scope with no
 * build step (Row 15). Prefixed with this app's name so a person reading the
 * directory can tell whose it is without opening it.
 */
export const OPENCODE_PLUGIN_FILE = 'dwarfai-miners-permission.ts'

/** First line of every file this app writes there, and the whole ownership test. */
export const OPENCODE_PLUGIN_HEADER =
  '// dwarfai-miners:opencode-permission-plugin -- written by DwarfAI-Miners; turn it off in Settings to remove it.'

const PUSH_URL_PLACEHOLDER = '__DWARFAI_OPENCODE_PUSH_URL__'
const PUSH_TOKEN_PLACEHOLDER = '__DWARFAI_OPENCODE_PUSH_TOKEN__'

/** Both values land inside a single-quoted literal, so only these shapes are ever baked in. */
const TOKEN_PATTERN = /^[0-9a-f]{16,}$/
const PUSH_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/_-]*$/

/**
 * OpenCode's global plugin directory on this machine, or null when it cannot
 * be known.
 *
 * docs/opencode-format.md Row 15: OpenCode resolves its global config as
 * `$XDG_CONFIG_HOME/opencode` when set, else `~/.config/opencode`, with NO
 * platform branch (read from the shipped 1.18.31 binary; measured live on
 * Windows only). So the rule is the same on all three platforms and only the
 * path syntax is per-OS, which is why the platform is a parameter here and
 * not read. Blank counts as unset, the convention every configuration layer
 * in this app holds. A RELATIVE value is refused rather than resolved: OpenCode
 * would resolve it against its own working directory, which differs per
 * session, so no single directory this app could write to is the right one.
 */
export function openCodeGlobalPluginDir(
  home: string,
  env: Record<string, string | undefined>,
  platform: Platform
): string | null {
  const path = platform === 'win32' ? win32 : posix
  const configured = env.XDG_CONFIG_HOME?.trim()
  let configHome: string
  if (configured === undefined || configured === '') {
    configHome = path.join(home, '.config')
  } else if (path.isAbsolute(configured)) {
    configHome = configured
  } else {
    return null
  }
  return path.join(configHome, 'opencode', 'plugin')
}

function replaceOnce(source: string, placeholder: string, value: string): string {
  const parts = source.split(placeholder)
  if (parts.length !== 2) {
    throw new Error(
      `The OpenCode plugin source must carry the ${placeholder} placeholder exactly once, ` +
        `found ${parts.length - 1}`
    )
  }
  return parts.join(value)
}

/**
 * The exact bytes to write: the header, then the artifact with the real push
 * address and this install's token substituted.
 *
 * Throws rather than writing a plugin that would post nowhere, or a literal a
 * stray quote could break out of. The token is plaintext in the result by
 * necessity — the plugin has to present it — which is the coupling Settings
 * states to the person before they turn this on.
 */
export function buildOpenCodePluginFile(options: {
  source: string
  pushUrl: string
  token: string
}): string {
  if (!TOKEN_PATTERN.test(options.token)) {
    throw new Error('Refusing to write the OpenCode plugin with a malformed token')
  }
  if (!PUSH_URL_PATTERN.test(options.pushUrl)) {
    throw new Error('Refusing to write the OpenCode plugin with a non-loopback push address')
  }
  const withUrl = replaceOnce(options.source, PUSH_URL_PLACEHOLDER, options.pushUrl)
  const withToken = replaceOnce(withUrl, PUSH_TOKEN_PLACEHOLDER, options.token)
  return `${OPENCODE_PLUGIN_HEADER}\n${withToken}`
}

function pluginPath(pluginDir: string): string {
  // The directory already carries its platform's separator; appending with
  // the same one keeps the result in that syntax.
  const separator = pluginDir.includes('\\') ? '\\' : '/'
  return `${pluginDir.replace(/[\\/]+$/, '')}${separator}${OPENCODE_PLUGIN_FILE}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface OpenCodePluginInstallReport {
  path: string
  /** Whether the file was actually written. */
  changed: boolean
  /** Whether this call created the plugin directory, so uninstall may remove it again. */
  createdDir: boolean
  /** Why nothing was written, when something went wrong. */
  error?: string
}

export interface OpenCodePluginUninstallReport {
  path: string
  /** Whether the file was actually removed. */
  changed: boolean
  error?: string
}

/**
 * Write the plugin, creating OpenCode's plugin directory only when it does
 * not exist yet. Identical bytes are left alone; a file of ours with an old
 * port or token is refreshed; a file of the same name that is not ours is
 * reported and left exactly as found.
 */
export async function installOpenCodePlugin(options: {
  fs: HookFsLike
  pluginDir: string
  content: string
}): Promise<OpenCodePluginInstallReport> {
  const path = pluginPath(options.pluginDir)
  const report: OpenCodePluginInstallReport = { path, changed: false, createdDir: false }
  try {
    const existing = await options.fs.readText(path)
    if (existing !== null && !existing.startsWith(OPENCODE_PLUGIN_HEADER)) {
      return {
        ...report,
        error: `A file this app did not write is already at ${path}; it was left untouched.`
      }
    }
    if (existing === options.content) return report

    const createdDir = !(await options.fs.exists(options.pluginDir))
    if (createdDir) await options.fs.ensureDir(options.pluginDir)
    // Owner-only (#588 T6 security fix): this file carries the hook token in
    // plain text, by necessity (see the module comment above).
    await options.fs.writeSecretText(path, options.content)
    return { path, changed: true, createdDir }
  } catch (error) {
    return { ...report, error: messageOf(error) }
  }
}

/**
 * Remove exactly what `installOpenCodePlugin` wrote: our file, and the
 * directory only when `removeDir` says this app created it — and even then
 * only while it is empty, because it is also where the person's own plugins
 * live.
 */
export async function uninstallOpenCodePlugin(options: {
  fs: HookFsLike
  pluginDir: string
  removeDir: boolean
}): Promise<OpenCodePluginUninstallReport> {
  const path = pluginPath(options.pluginDir)
  const report: OpenCodePluginUninstallReport = { path, changed: false }
  try {
    const existing = await options.fs.readText(path)
    if (existing !== null && !existing.startsWith(OPENCODE_PLUGIN_HEADER)) return report
    if (existing !== null) {
      await options.fs.remove(path)
      report.changed = true
    }
    if (options.removeDir) await options.fs.removeEmptyDir(options.pluginDir)
    return report
  } catch (error) {
    return { ...report, error: messageOf(error) }
  }
}
