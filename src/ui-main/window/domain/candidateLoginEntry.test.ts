// layer: L1
import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_AUTOSTART_LABEL,
  buildDesktopEntry,
  buildLaunchAgentPlist,
  buildWindowsRunValue,
  planAutostartMigration
} from './candidateLoginEntry'

/**
 * The candidate login entry's bytes per OS (21 §2 cut 1), transplanted from `src/main/platform/autostartEntries.test.ts`
 * and `src/main/shell/autostart.test.ts` (17 §2.5) with the expectations unchanged: the entry UI main writes until v1 is
 * byte for byte the one today's runtime wrote.
 */
describe('the candidate login entry text (21 §2 cut 1)', () => {
  it('[ADR-027] the macOS LaunchAgent runs the app once at login and is never kept alive', () => {
    const plist = buildLaunchAgentPlist({
      executable: '/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners',
      args: []
    })
    expect(CANDIDATE_AUTOSTART_LABEL).toBe('com.jeronimorepetto.dwarfaiminers')
    expect(plist).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '\t<key>Label</key>',
        '\t<string>com.jeronimorepetto.dwarfaiminers</string>',
        '\t<key>ProgramArguments</key>',
        '\t<array>',
        '\t\t<string>/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners</string>',
        '\t</array>',
        '\t<key>RunAtLoad</key>',
        '\t<true/>',
        // The panel is a normal app the person can quit; launchd must not restart it after Quit.
        '\t<key>KeepAlive</key>',
        '\t<false/>',
        '</dict>',
        '</plist>',
        ''
      ].join('\n')
    )
  })

  it('[ADR-027] the macOS LaunchAgent lists every argument as its own ProgramArguments entry', () => {
    const plist = buildLaunchAgentPlist({
      executable: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      args: ['/repo/agent name']
    })
    expect(plist).toContain(
      '\t\t<string>/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron</string>\n\t\t<string>/repo/agent name</string>'
    )
  })

  it('[ADR-027] the macOS LaunchAgent escapes XML syntax in a path instead of producing a broken plist', () => {
    const plist = buildLaunchAgentPlist({ executable: '/Apps/a&b<c>/App', args: [] })
    expect(plist).toContain('<string>/Apps/a&amp;b&lt;c&gt;/App</string>')
  })

  it('[ADR-027] the XDG autostart entry launches the app with no terminal', () => {
    expect(buildDesktopEntry({ executable: '/opt/DwarfAI-Miners/dwarfai-miners', args: [] })).toBe(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=DwarfAI-Miners',
        'Comment=Floating panel that visualizes AI coding agents as dwarfs working in mines.',
        'Exec=/opt/DwarfAI-Miners/dwarfai-miners',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        ''
      ].join('\n')
    )
  })

  it('[ADR-027] the XDG autostart entry quotes an argument containing spaces, as the Desktop Entry spec requires', () => {
    const entry = buildDesktopEntry({
      executable: '/opt/My Apps/dwarfai-miners',
      args: ['/home/j/agent name']
    })
    expect(entry).toContain('Exec="/opt/My Apps/dwarfai-miners" "/home/j/agent name"')
  })

  it('[ADR-027] the XDG autostart entry escapes the characters the spec reserves inside a quoted argument', () => {
    const entry = buildDesktopEntry({ executable: '/opt/a "b" $c\\d', args: [] })
    expect(entry).toContain('Exec="/opt/a \\"b\\" \\$c\\\\d"')
  })

  it('[ADR-027] the Windows Run value quotes the executable and each argument', () => {
    expect(buildWindowsRunValue({ executable: 'C:\\Apps\\DwarfAI-Miners.exe', args: [] })).toBe(
      '"C:\\Apps\\DwarfAI-Miners.exe"'
    )
    expect(
      buildWindowsRunValue({ executable: 'C:\\electron.exe', args: ['C:\\repo\\agent-name'] })
    ).toBe('"C:\\electron.exe" "C:\\repo\\agent-name"')
  })
})

describe('the AgentName Run value migration plan (21 §2 cut 1)', () => {
  it('[ADR-027] does nothing when the legacy value is absent, whether or not autostart reads as on', () => {
    expect(planAutostartMigration({ legacyValuePresent: false, autostartEnabled: false })).toEqual({
      deleteLegacy: false,
      writeNew: false
    })
    expect(planAutostartMigration({ legacyValuePresent: false, autostartEnabled: true })).toEqual({
      deleteLegacy: false,
      writeNew: false
    })
  })

  it('[ADR-027] removes a stale legacy value without turning autostart on when it was off', () => {
    expect(planAutostartMigration({ legacyValuePresent: true, autostartEnabled: false })).toEqual({
      deleteLegacy: true,
      writeNew: false
    })
  })

  it('[ADR-027] moves the legacy value to the new name when autostart was on', () => {
    expect(planAutostartMigration({ legacyValuePresent: true, autostartEnabled: true })).toEqual({
      deleteLegacy: true,
      writeNew: true
    })
  })
})
