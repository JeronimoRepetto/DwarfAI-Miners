// The AppPaths double (16 §3): fixed values a test chooses, frozen like the real adapter's.
import type { AppPaths } from '../ports/appPaths'

export class FakeAppPaths implements AppPaths {
  readonly userDataDir: string
  readonly execPath: string
  readonly resourcesPath: string | null
  readonly isPackaged: boolean

  constructor(values: Partial<AppPaths> = {}) {
    this.userDataDir = values.userDataDir ?? 'fake-user-data/host'
    this.execPath = values.execPath ?? 'fake-install/DwarfAI-Miners'
    this.resourcesPath = values.resourcesPath ?? null
    this.isPackaged = values.isPackaged ?? false
    Object.freeze(this)
  }
}
