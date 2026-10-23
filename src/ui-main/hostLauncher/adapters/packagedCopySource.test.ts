// layer: L1
// The copy source and the copy target of each packaged layout (ADR-027 items 1-2; ADR-002 D5; 20 §3.2 column "Host
// runs from"; SP-03 decision table), table-driven with an explicit platform (17 §1.13): pure path arithmetic, so every
// OS's rows run on every OS.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { versionedCopyRoot } from '@dwarfai/contracts'
import type { CopyPlatform } from '../copySource'
import { packagedCopyPlan } from './packagedCopySource'

const VERSION = '1.4.0'

interface LayoutRow {
  layout: string
  platform: CopyPlatform
  /** `process.execPath` of the packaged UI in that layout. */
  execPath: string
  env: Record<string, string>
  homeDir: string
  /** The directory copied: the one holding the executable, the whole `.app` on macOS. */
  sourceDir: string
  /** `host/<version>/` at the ADR-027 item 2 path. */
  copyDir: string
  /** Where the Host's executable runs from, inside the copy. */
  executable: string
}

const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' }

const LAYOUTS: LayoutRow[] = [
  {
    layout: 'Windows Scoop zip (started through the current junction)',
    platform: 'win32',
    execPath: 'C:\\Users\\p\\scoop\\apps\\dwarfai-miners\\current\\DwarfAI-Miners.exe',
    env: WIN_ENV,
    homeDir: 'C:\\Users\\p',
    sourceDir: 'C:\\Users\\p\\scoop\\apps\\dwarfai-miners\\current',
    copyDir: 'C:\\Users\\p\\AppData\\Local\\DwarfAI\\host\\1.4.0',
    executable: 'C:\\Users\\p\\AppData\\Local\\DwarfAI\\host\\1.4.0\\DwarfAI-Miners.exe'
  },
  {
    layout: 'Windows nsis per-user install directory',
    platform: 'win32',
    execPath: 'C:\\Users\\p\\AppData\\Local\\Programs\\dwarfai-miners\\DwarfAI-Miners.exe',
    env: WIN_ENV,
    homeDir: 'C:\\Users\\p',
    sourceDir: 'C:\\Users\\p\\AppData\\Local\\Programs\\dwarfai-miners',
    copyDir: 'C:\\Users\\p\\AppData\\Local\\DwarfAI\\host\\1.4.0',
    executable: 'C:\\Users\\p\\AppData\\Local\\DwarfAI\\host\\1.4.0\\DwarfAI-Miners.exe'
  },
  {
    layout: 'macOS .app (dmg or zip, in /Applications)',
    platform: 'darwin',
    execPath: '/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners',
    env: {},
    homeDir: '/Users/p',
    sourceDir: '/Applications/DwarfAI-Miners.app',
    copyDir: '/Users/p/Library/Application Support/DwarfAI/host/1.4.0',
    executable:
      '/Users/p/Library/Application Support/DwarfAI/host/1.4.0/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners'
  },
  {
    layout: 'Linux AppImage (its FUSE mount)',
    platform: 'linux',
    execPath: '/tmp/.mount_DwarfAx1y2z3/dwarfai-miners',
    env: {},
    homeDir: '/home/p',
    sourceDir: '/tmp/.mount_DwarfAx1y2z3',
    copyDir: '/home/p/.local/share/dwarfai/host/1.4.0',
    executable: '/home/p/.local/share/dwarfai/host/1.4.0/dwarfai-miners'
  },
  {
    layout: 'Linux deb (/opt install), with XDG_DATA_HOME set',
    platform: 'linux',
    execPath: '/opt/DwarfAI-Miners/dwarfai-miners',
    env: { XDG_DATA_HOME: '/home/p/data' },
    homeDir: '/home/p',
    sourceDir: '/opt/DwarfAI-Miners',
    copyDir: '/home/p/data/dwarfai/host/1.4.0',
    executable: '/home/p/data/dwarfai/host/1.4.0/dwarfai-miners'
  }
]

function planOf(row: LayoutRow) {
  const root = versionedCopyRoot({
    platform: row.platform,
    build: 'release',
    env: row.env,
    homeDir: row.homeDir
  })
  if (!root.ok) throw new Error(`no copy root for ${row.layout}: ${root.errCode}`)
  return packagedCopyPlan({
    execPath: row.execPath,
    platform: row.platform,
    version: VERSION,
    root: root.value
  })
}

/** Whether `inner` is `outer` or below it, on the row's own path rules. */
function within(inner: string, outer: string, platform: CopyPlatform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const relative = paths.relative(outer, inner)
  return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative))
}

describe('the copy source and target of each packaged layout (ADR-027 item 2; SP-03)', () => {
  it('[ADR-027] each packaged layout resolves its copy source and the per-OS target host/<version>/ of ADR-027 item 2', () => {
    for (const row of LAYOUTS) {
      expect(planOf(row), row.layout).toMatchObject({
        sourceDir: row.sourceDir,
        copyDir: row.copyDir,
        executable: row.executable
      })
    }
  })

  it("[ADR-027] the install directory is never returned as the Host's execution path", () => {
    for (const row of LAYOUTS) {
      const plan = planOf(row)
      expect(within(plan.executable, plan.sourceDir, row.platform), row.layout).toBe(false)
      expect(within(plan.contentDir, plan.sourceDir, row.platform), row.layout).toBe(false)
      expect(within(plan.executable, plan.contentDir, row.platform), row.layout).toBe(true)
      expect(within(plan.contentDir, plan.copyDir, row.platform), row.layout).toBe(true)
    }
  })
})
