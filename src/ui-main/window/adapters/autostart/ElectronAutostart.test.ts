// layer: L3
import { describe, expect, it } from 'vitest'
import type { LoginItemSettings, Settings } from 'electron'
import { runAutostartContract, type AutostartSubject } from '../../ports/autostart.contract'
import { ElectronAutostart, type AutostartFs, type LoginItemApp } from './ElectronAutostart'

/**
 * `ElectronAutostart` on each OS over a model of what that OS keeps, so the three per-OS branches (R18: here only) are
 * asserted on any host (17 §1.3). The models follow Electron 44's documented `app.setLoginItemSettings` /
 * `getLoginItemSettings` fields (`electron.d.ts`): on Windows a Run value per `name` with its `path` and `args`, and
 * whether it is startup-approved (`launchItems[].enabled`, Task Manager's "Startup apps"); on macOS the login item's
 * `status`. Linux has no Electron login item: the entry is an XDG autostart file. A refusal leaves the OS state as it
 * was, as Electron's setter does (it returns nothing). What each OS really reports is S-027-4's; the real-OS leg of
 * these cases is ElectronAutostart.os.test.ts.
 */
const LAUNCH = 'C:\\Program Files\\DwarfAI-Miners\\DwarfAI-Miners.exe'
const NAME = 'DwarfAI-Miners'
const ARGS = ['--background']

class WindowsModel implements LoginItemApp {
  readonly run = new Map<string, { path: string; args: string[] }>()
  readonly approved = new Map<string, boolean>()
  refuse = false
  writes = 0

  setLoginItemSettings(settings: Settings): void {
    if (this.refuse) return
    const name = settings.name ?? 'com.squirrel.default'
    if (settings.openAtLogin === true) {
      this.writes += 1
      this.run.set(name, {
        path: settings.path ?? 'electron.exe',
        args: [...(settings.args ?? [])]
      })
      this.approved.set(name, settings.enabled ?? true)
    } else {
      this.run.delete(name)
      this.approved.delete(name)
    }
  }

  getLoginItemSettings(): LoginItemSettings {
    // As Electron 44 reads a Run value back on Windows (observed by ElectronAutostart.os.test.ts's run on Windows 11):
    // the value's arguments without the first one.
    const launchItems = [...this.run].map(([name, value]) => ({
      name,
      path: value.path,
      args: value.args.slice(1),
      scope: 'user' as const,
      enabled: this.approved.get(name) ?? true
    }))
    return {
      openAtLogin: launchItems.length > 0,
      executableWillLaunchAtLogin: launchItems.some((item) => item.enabled),
      launchItems,
      wasOpenedAtLogin: false,
      status: 'not-registered'
    }
  }
}

class MacModel implements LoginItemApp {
  status: LoginItemSettings['status'] = 'not-registered'
  refuse = false
  writes = 0

  setLoginItemSettings(settings: Settings): void {
    if (this.refuse) return
    if (settings.openAtLogin === true) {
      this.writes += 1
      this.status = 'enabled'
    } else this.status = 'not-registered'
  }

  getLoginItemSettings(): LoginItemSettings {
    return {
      openAtLogin: this.status === 'enabled',
      wasOpenedAtLogin: false,
      status: this.status,
      executableWillLaunchAtLogin: false,
      launchItems: []
    }
  }
}

/** An in-memory folder tree for the XDG entry; `refuse` makes every write and removal fail as a read-only folder. */
class MemoryFs implements AutostartFs {
  readonly files = new Map<string, string>()
  refuse = false
  writes = 0

  private refused(): Error {
    return Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  }
  readFileSync(path: string): string {
    const content = this.files.get(path)
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    }
    return content
  }
  writeFileSync(path: string, data: string): void {
    if (this.refuse) throw this.refused()
    this.writes += 1
    this.files.set(path, data)
  }
  renameSync(from: string, to: string): void {
    if (this.refuse) throw this.refused()
    this.files.set(to, this.readFileSync(from))
    this.files.delete(from)
  }
  mkdirSync(): unknown {
    if (this.refuse) throw this.refused()
    return undefined
  }
  rmSync(path: string): void {
    if (this.refuse) throw this.refused()
    this.files.delete(path)
  }
}

const unusedApp: LoginItemApp = {
  setLoginItemSettings: () => {
    throw new Error('Linux has no Electron login item')
  },
  getLoginItemSettings: () => {
    throw new Error('Linux has no Electron login item')
  }
}

function windows(): AutostartSubject & { model: WindowsModel; autostart: ElectronAutostart } {
  const model = new WindowsModel()
  const autostart = new ElectronAutostart({
    platform: 'win32',
    app: model,
    launchPath: LAUNCH,
    args: ARGS,
    name: NAME,
    home: 'C:\\Users\\j',
    env: {}
  })
  return {
    model,
    autostart,
    writes: () => model.writes,
    disableInOs: () => model.approved.set(NAME, false),
    refuseWrites: () => (model.refuse = true)
  }
}

function mac(): AutostartSubject & { model: MacModel } {
  const model = new MacModel()
  return {
    model,
    autostart: new ElectronAutostart({
      platform: 'darwin',
      app: model,
      launchPath: '/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners',
      args: ARGS,
      name: NAME,
      home: '/Users/j',
      env: {}
    }),
    writes: () => model.writes,
    // The person turns DwarfAI off in System Settings → Login Items (UNVERIFIED per macOS version, S-027-4).
    disableInOs: () => (model.status = 'requires-approval'),
    refuseWrites: () => (model.refuse = true)
  }
}

const XDG_ENTRY = '/home/j/.config/autostart/dwarfai-miners.desktop'

function linux(
  env: Record<string, string | undefined> = {},
  launchPath = '/opt/DwarfAI-Miners/dwarfai-miners'
): AutostartSubject & { fs: MemoryFs } {
  const fs = new MemoryFs()
  return {
    fs,
    autostart: new ElectronAutostart({
      platform: 'linux',
      app: unusedApp,
      launchPath,
      args: ARGS,
      name: NAME,
      home: '/home/j',
      env,
      fs
    }),
    writes: () => fs.writes,
    // GNOME's "Startup Applications" (and Tweaks) turn an entry off with this key in the person's own copy.
    disableInOs: () => {
      const entry = fs.files.get(XDG_ENTRY) ?? ''
      fs.files.set(
        XDG_ENTRY,
        entry.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false')
      )
    },
    refuseWrites: () => (fs.refuse = true)
  }
}

runAutostartContract('ElectronAutostart on Windows', windows)
runAutostartContract('ElectronAutostart on macOS', mac)
runAutostartContract('ElectronAutostart on Linux', linux)

describe('ElectronAutostart, per OS (ADR-027 item 7)', () => {
  it('[S-027-4] on Windows the entry is a per-user Run value named for the app that starts the launch path with --background, enabled', () => {
    const { model, autostart } = windows()
    autostart.set(true)

    expect([...model.run]).toEqual([[NAME, { path: LAUNCH, args: ['--background'] }]])
    expect(model.approved.get(NAME)).toBe(true)
    // A Run value of this name pointing at another path (an older install) does not start this app: get reads false,
    // and set(true) repairs it.
    model.run.set(NAME, { path: 'C:\\Old\\DwarfAI-Miners.exe', args: ['--background'] })
    expect(autostart.get()).toBe(false)
    autostart.set(true)
    expect(model.run.get(NAME)).toEqual({ path: LAUNCH, args: ['--background'] })
    // A value of this name without --background (today's candidate writes one): Electron cannot read the arguments
    // back, so set(true) rewrites the value with them.
    model.run.set(NAME, { path: LAUNCH, args: [] })
    autostart.set(true)
    expect(model.run.get(NAME)).toEqual({ path: LAUNCH, args: ['--background'] })
    // Another app's Run values are never read as ours, nor touched.
    model.run.set('SomethingElse', { path: LAUNCH, args: ['--background'] })
    autostart.set(false)
    expect([...model.run.keys()]).toEqual(['SomethingElse'])
  })

  it('[S-027-4] on Linux the entry is an XDG autostart file whose Exec starts the launch path with --background', () => {
    const { fs, autostart } = linux({}, '/opt/DwarfAI Miners/dwarfai-miners')
    autostart.set(true)

    expect(fs.files.get(XDG_ENTRY)).toBe(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=DwarfAI-Miners',
        'Exec="/opt/DwarfAI Miners/dwarfai-miners" --background',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        ''
      ].join('\n')
    )
    // An entry already as it should be is not written again.
    autostart.set(true)
    expect(fs.writes).toBe(1)
    // An entry whose Exec starts something else is not ours as it stands: it reads false and is rewritten.
    fs.files.set(XDG_ENTRY, (fs.files.get(XDG_ENTRY) ?? '').replace(' --background', ''))
    expect(autostart.get()).toBe(false)
    autostart.set(true)
    expect(autostart.get()).toBe(true)
  })

  it('[S-027-4] on Linux an absolute XDG_CONFIG_HOME holds the entry, a relative one is ignored, and Exec quotes what the spec reserves', () => {
    const absolute = linux({ XDG_CONFIG_HOME: '/home/j/cfg' })
    absolute.autostart.set(true)
    expect([...absolute.fs.files.keys()]).toEqual(['/home/j/cfg/autostart/dwarfai-miners.desktop'])

    const relative = linux({ XDG_CONFIG_HOME: 'cfg' })
    relative.autostart.set(true)
    expect([...relative.fs.files.keys()]).toEqual([XDG_ENTRY])

    const reserved = linux({}, '/opt/a"b$c`d\\e%f/run')
    reserved.autostart.set(true)
    // The Desktop Entry quoting first (a backslash before each of " $ ` and \ inside the double quotes), then the
    // string escape that doubles every backslash, and % as %%.
    expect(reserved.fs.files.get(XDG_ENTRY)).toContain(
      'Exec="/opt/a\\\\"b\\\\$c\\\\`d\\\\\\\\e%%f/run" --background'
    )
    expect(reserved.autostart.get()).toBe(true)
  })
})
