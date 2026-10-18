// The candidate login entry (21 §2 cut 1, "Login autostart entry"): what today's autostart writes on each OS, as pure
// text, ported unchanged from `src/main/platform/autostartEntries.ts` and `autostartPorts.ts` so UI main can own the
// candidate writer before the legacy runtime is deleted (ISSUE-243). It stays the one writer of the entry on every OS
// where S-027-4 has not passed (loginEntryGate.ts) until v1; where it passed, `ElectronAutostart` writes the entry.
// Pure: a string in, a string out, so the bytes each OS's loader parses are pinned by unit tests.

/** The launchd label, which is also the app id electron-builder ships. */
export const CANDIDATE_AUTOSTART_LABEL = 'com.jeronimorepetto.dwarfaiminers'
/** The Run value name and the `Name=` of the desktop entry. */
export const CANDIDATE_AUTOSTART_NAME = 'DwarfAI-Miners'
/** The Run value name a release before the rename wrote; kept only to migrate an install away from it. */
export const CANDIDATE_LEGACY_RUN_NAME = 'AgentName'
/** Basename of the XDG autostart entry. */
export const CANDIDATE_DESKTOP_FILE = 'dwarfai-miners.desktop'

const AUTOSTART_COMMENT =
  'Floating panel that visualizes AI coding agents as dwarfs working in mines.'

/**
 * What to run at login: an executable plus its arguments, never a pre-joined command line. launchd wants exactly this
 * shape, and the other two OSes quote it themselves.
 */
export interface LaunchCommand {
  executable: string
  args: readonly string[]
}

function escapeXmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** A launchd user agent that starts the app once at login; never kept alive, so the tray's Quit means quit. */
export function buildLaunchAgentPlist(
  command: LaunchCommand,
  label: string = CANDIDATE_AUTOSTART_LABEL
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
 * One `Exec=` argument as the Desktop Entry specification quotes it: an argument with a space is double-quoted, and
 * inside those quotes `"`, `` ` ``, `$` and `\` are backslash-escaped.
 */
function quoteDesktopExecArgument(argument: string): string {
  const escaped = argument.replace(/[\\"`$]/g, (character) => `\\${character}`)
  return escaped === argument && !/[\s]/.test(argument) ? argument : `"${escaped}"`
}

/** An XDG autostart entry that launches the app with no terminal at session start. */
export function buildDesktopEntry(command: LaunchCommand): string {
  const exec = [command.executable, ...command.args].map(quoteDesktopExecArgument).join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${CANDIDATE_AUTOSTART_NAME}`,
    `Comment=${AUTOSTART_COMMENT}`,
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

/**
 * The command line written to the Run value. Windows re-parses this string, so every part is quoted: a path with a
 * space in it (`C:\Program Files\...`) is the normal case here.
 */
export function buildWindowsRunValue(command: LaunchCommand): string {
  return [command.executable, ...command.args].map((argument) => `"${argument}"`).join(' ')
}

export interface AutostartMigrationState {
  /** Whether the legacy `AgentName` Run value is present. */
  legacyValuePresent: boolean
  /** Whether autostart was on, checked before the legacy value is touched. */
  autostartEnabled: boolean
}

export interface AutostartMigrationPlan {
  /** Remove the legacy `AgentName` Run value. */
  deleteLegacy: boolean
  /** (Re)write the `DwarfAI-Miners` Run value. */
  writeNew: boolean
}

/**
 * The one-time `AgentName` → `DwarfAI-Miners` Run value rename, as a decision table:
 *
 * | legacyValuePresent | autostartEnabled | deleteLegacy | writeNew |
 * | ------------------ | ---------------- | ------------ | -------- |
 * | false              | false            | false        | false    |
 * | false              | true             | false        | false    |
 * | true               | false            | true         | false    |
 * | true               | true             | true         | true     |
 *
 * A legacy value, once found, is always removed; the new value is written only when autostart was on, so a person who
 * had opted out stays opted out under the new name. Once the legacy value is gone every later start does nothing.
 */
export function planAutostartMigration(state: AutostartMigrationState): AutostartMigrationPlan {
  return {
    deleteLegacy: state.legacyValuePresent,
    writeNew: state.legacyValuePresent && state.autostartEnabled
  }
}
