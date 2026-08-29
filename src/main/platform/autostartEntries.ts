import { posix } from 'node:path'
import type { Platform } from './platform'

/**
 * Pure builders for the three things "start at login" means on the three
 * platforms: a Run-key command line, a launchd LaunchAgent plist, and an XDG
 * autostart desktop entry.
 *
 * Everything here is a string in, a string out, so the exact bytes each
 * platform's loader will parse are pinned by unit tests instead of discovered
 * on a user's machine.
 */

/** The launchd label, which is also the app id electron-builder ships. */
export const AUTOSTART_LABEL = 'com.jeronimorepetto.dwarfaiminers'
/** The Run value name and the Name= of the desktop entry. */
export const AUTOSTART_APP_NAME = 'DwarfAI-Miners'
/** Basename of the XDG autostart entry. */
export const AUTOSTART_DESKTOP_FILE = 'dwarfai-miners.desktop'

const AUTOSTART_COMMENT =
  'Floating panel that visualizes AI coding agents as dwarfs working in mines.'

/**
 * What to run at login: an executable plus its arguments, never a pre-joined
 * command line. A packaged build passes no arguments; a development run passes
 * the app path to Electron. launchd wants exactly this shape, and the other
 * two platforms quote it themselves.
 */
export interface LaunchCommand {
  executable: string
  args: string[]
}

/**
 * The tray checkbox label. Windows users know this setting as "Start with
 * Windows"; on macOS and Linux the same idea is called starting at login, and
 * naming the wrong operating system in the menu would read as a porting bug.
 */
export function autostartMenuLabel(platform: Platform): string {
  return platform === 'win32' ? 'Start with Windows' : 'Start at login'
}

/** ~/Library/LaunchAgents/<label>.plist — the per-user, no-privileges location. */
export function launchAgentPlistPath(home: string, label: string = AUTOSTART_LABEL): string {
  return posix.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
}

function escapeXmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * A launchd user agent that starts the app once at login.
 *
 * KeepAlive is explicitly false: the tray "Quit" item means quit, and an agent
 * that relaunches the app the moment the user quits it would be a bug the user
 * cannot get out of.
 */
export function buildLaunchAgentPlist(
  command: LaunchCommand,
  label: string = AUTOSTART_LABEL
): string {
  const programArguments = [command.executable, ...command.args]
    .map((argument) => `\t\t<string>${escapeXmlText(argument)}</string>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${escapeXmlText(label)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    programArguments,
    '\t</array>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<false/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

/**
 * ~/.config/autostart/dwarfai-miners.desktop, honouring XDG_CONFIG_HOME. The
 * XDG base-directory spec says a relative value is invalid and must be treated
 * as unset, which is what keeps a stray `XDG_CONFIG_HOME=cfg` from scattering
 * an autostart entry into whatever directory the app happened to start in.
 */
export function xdgAutostartPath(home: string, env: NodeJS.ProcessEnv): string {
  const configured = env.XDG_CONFIG_HOME
  const configHome =
    configured !== undefined && configured.startsWith('/')
      ? configured
      : posix.join(home, '.config')
  return posix.join(configHome, 'autostart', AUTOSTART_DESKTOP_FILE)
}

/**
 * Quote one Exec= argument per the Desktop Entry specification: an argument
 * with a space (or any reserved character) is double-quoted, and inside those
 * quotes `"`, `` ` ``, `$` and `\` are backslash-escaped.
 */
function quoteDesktopExecArgument(argument: string): string {
  const escaped = argument.replace(/[\\"`$]/g, (character) => `\\${character}`)
  return escaped === argument && !/[\s]/.test(argument) ? argument : `"${escaped}"`
}

/** An XDG autostart entry that launches the app windowless at session start. */
export function buildDesktopEntry(command: LaunchCommand): string {
  const exec = [command.executable, ...command.args].map(quoteDesktopExecArgument).join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${AUTOSTART_APP_NAME}`,
    `Comment=${AUTOSTART_COMMENT}`,
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

/**
 * The command line written to the Run key. Windows re-parses this string, so
 * every part is quoted — a path with a space in it is the normal case here
 * (`C:\Program Files\...`), not the exception.
 */
export function buildWindowsRunValue(command: LaunchCommand): string {
  return [command.executable, ...command.args].map((argument) => `"${argument}"`).join(' ')
}
