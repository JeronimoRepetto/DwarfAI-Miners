import { describe, expect, it } from 'vitest'
import {
  AUTOSTART_LABEL,
  autostartMenuLabel,
  buildDesktopEntry,
  buildLaunchAgentPlist,
  buildWindowsRunValue,
  launchAgentPlistPath,
  xdgAutostartPath
} from './autostartEntries'

describe('autostartMenuLabel', () => {
  it('names Windows only on Windows', () => {
    expect(autostartMenuLabel('win32')).toBe('Start with Windows')
    expect(autostartMenuLabel('darwin')).toBe('Start at login')
    expect(autostartMenuLabel('linux')).toBe('Start at login')
  })
})

describe('launchAgentPlistPath', () => {
  it('lands in the per-user LaunchAgents directory under the bundle id', () => {
    expect(launchAgentPlistPath('/Users/j')).toBe(
      '/Users/j/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist'
    )
    expect(AUTOSTART_LABEL).toBe('com.jeronimorepetto.dwarfaiminers')
  })
})

describe('buildLaunchAgentPlist', () => {
  it('produces a launchd agent that runs the app once at login', () => {
    const plist = buildLaunchAgentPlist({
      executable: '/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners',
      args: []
    })
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
        // The panel is a normal app the user can quit; launchd must not keep
        // restarting it after Quit, the way the tray "Quit" item means it.
        '\t<key>KeepAlive</key>',
        '\t<false/>',
        '</dict>',
        '</plist>',
        ''
      ].join('\n')
    )
  })

  it('lists every argument as its own ProgramArguments entry', () => {
    // A dev run launches electron with the project path; launchd takes argv,
    // never a shell command line, so the split has to survive verbatim.
    const plist = buildLaunchAgentPlist({
      executable: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      args: ['/repo/agent name']
    })
    expect(plist).toContain(
      '\t\t<string>/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron</string>\n\t\t<string>/repo/agent name</string>'
    )
  })

  it('escapes XML syntax in a path instead of producing a broken plist', () => {
    const plist = buildLaunchAgentPlist({ executable: '/Apps/a&b<c>/App', args: [] })
    expect(plist).toContain('<string>/Apps/a&amp;b&lt;c&gt;/App</string>')
  })
})

describe('xdgAutostartPath', () => {
  it('defaults to ~/.config/autostart', () => {
    expect(xdgAutostartPath('/home/j', {})).toBe('/home/j/.config/autostart/dwarfai-miners.desktop')
  })

  it('honours XDG_CONFIG_HOME when the user set one', () => {
    expect(xdgAutostartPath('/home/j', { XDG_CONFIG_HOME: '/home/j/cfg' })).toBe(
      '/home/j/cfg/autostart/dwarfai-miners.desktop'
    )
  })

  it('ignores a relative XDG_CONFIG_HOME, which the spec says is invalid', () => {
    expect(xdgAutostartPath('/home/j', { XDG_CONFIG_HOME: 'cfg' })).toBe(
      '/home/j/.config/autostart/dwarfai-miners.desktop'
    )
  })
})

describe('buildDesktopEntry', () => {
  it('produces an XDG autostart entry that launches the app with no terminal', () => {
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

  it('quotes an argument containing spaces, as the Desktop Entry spec requires', () => {
    const entry = buildDesktopEntry({
      executable: '/opt/My Apps/dwarfai-miners',
      args: ['/home/j/agent name']
    })
    expect(entry).toContain('Exec="/opt/My Apps/dwarfai-miners" "/home/j/agent name"')
  })

  it('escapes the characters the spec reserves inside a quoted argument', () => {
    const entry = buildDesktopEntry({ executable: '/opt/a "b" $c\\d', args: [] })
    expect(entry).toContain('Exec="/opt/a \\"b\\" \\$c\\\\d"')
  })
})

describe('buildWindowsRunValue', () => {
  it('quotes the executable, and each argument, for the Run key command line', () => {
    expect(buildWindowsRunValue({ executable: 'C:\\Apps\\DwarfAI-Miners.exe', args: [] })).toBe(
      '"C:\\Apps\\DwarfAI-Miners.exe"'
    )
    expect(
      buildWindowsRunValue({ executable: 'C:\\electron.exe', args: ['C:\\repo\\agent-name'] })
    ).toBe('"C:\\electron.exe" "C:\\repo\\agent-name"')
  })
})
