// The shim resolution table of each OS (16 §4.4 contract "shim resolution table (Scoop, WinGet,
// `.cmd`) with explicit `Platform`"): what is installed where, and the target the resolver must
// answer for it. Synthetic machines only: user `j`, no real path (skills/privacy-guard).
import type { AgyPlaces, MachineInstall, Platform } from './installResolver.contract'

/** The home directory of the synthetic person on each OS. */
export const FIXTURE_HOME: Readonly<Record<Platform, string>> = {
  win32: 'C:\\Users\\j',
  darwin: '/Users/j',
  linux: '/home/j'
}

/** The PATH of the Host process on each OS (a GUI-started app's short PATH on POSIX). */
export const FIXTURE_PATH: Readonly<Record<Platform, string>> = {
  win32: 'C:\\Windows\\system32;C:\\Tools\\bin;C:\\Program Files\\nodejs',
  darwin: '/usr/bin:/bin:/opt/tools/bin',
  linux: '/usr/bin:/bin:/opt/tools/bin'
}

/** The directory only the login shell's PATH adds (a version manager's bin). */
export const FIXTURE_LOGIN_SHELL_DIR: Readonly<Record<'darwin' | 'linux', string>> = {
  darwin: '/Users/j/.nvm/versions/node/v24.0.0/bin',
  linux: '/home/j/.nvm/versions/node/v24.0.0/bin'
}

/** Where `DWARFAI_AGY_PATH` points on each OS. */
export const FIXTURE_AGY_OVERRIDE: Readonly<Record<Platform, string>> = {
  win32: 'D:\\Portable\\agy\\agy.exe',
  darwin: '/opt/agy/agy',
  linux: '/opt/agy/agy'
}

const W = 'C:\\Users\\j'

export const SHIM_TABLE: Readonly<Record<Platform, readonly MachineInstall[]>> = {
  win32: [
    {
      binary: 'alpha',
      layout: 'path',
      target: 'C:\\Tools\\bin\\alpha.exe',
      version: 'alpha 1.0.0'
    },
    {
      binary: 'bravo',
      layout: 'path-cmd',
      target: 'C:\\Tools\\bin\\node_modules\\bravo\\bin\\bravo.js',
      version: '2.1.0'
    },
    {
      binary: 'charlie',
      layout: 'path-bat',
      target: 'C:\\Tools\\charlie\\charlie.exe',
      version: 'charlie 3.0.0'
    },
    {
      binary: 'delta',
      layout: 'npm',
      target: `${W}\\AppData\\Roaming\\npm\\node_modules\\@acme\\delta\\bin\\delta.js`,
      version: '4.0.0 (Delta)'
    },
    {
      binary: 'echo',
      layout: 'pnpm',
      target: `${W}\\AppData\\Local\\pnpm\\global\\5\\node_modules\\echo\\bin\\echo.js`,
      version: 'echo-cli 0.5.0'
    },
    {
      binary: 'foxtrot',
      layout: 'volta',
      target: `${W}\\AppData\\Local\\Volta\\bin\\foxtrot.exe`,
      version: '6.0.0'
    },
    { binary: 'golf', layout: 'bun', target: `${W}\\.bun\\bin\\golf.exe`, version: '7.0.0' },
    {
      binary: 'hotel',
      layout: 'scoop',
      target: `${W}\\scoop\\apps\\hotel\\current\\hotel.exe`,
      version: 'hotel 8.0.0'
    },
    {
      binary: 'india',
      layout: 'winget',
      target: `${W}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Acme.India_8wekyb3d8bbwe\\india.exe`,
      version: 'india 9.0.0'
    },
    {
      binary: 'juliet',
      layout: 'local-bin',
      target: `${W}\\.local\\bin\\juliet.exe`,
      version: '10.0.0'
    }
  ],
  darwin: [
    { binary: 'alpha', layout: 'path', target: '/opt/tools/bin/alpha', version: 'alpha 1.0.0' },
    {
      binary: 'bravo',
      layout: 'path-link',
      target: '/opt/tools/lib/node_modules/bravo/bin/bravo.js',
      version: '2.1.0'
    },
    {
      binary: 'delta',
      layout: 'npm',
      target: '/Users/j/.npm-global/lib/node_modules/@acme/delta/cli.js',
      version: '4.0.0 (Delta)'
    },
    {
      binary: 'echo',
      layout: 'pnpm',
      target: '/Users/j/Library/pnpm/echo',
      version: 'echo-cli 0.5.0'
    },
    // A Volta shim dispatches on its own name: it is answered as itself, never as `volta-shim`.
    { binary: 'foxtrot', layout: 'volta', target: '/Users/j/.volta/bin/foxtrot', version: '6.0.0' },
    {
      binary: 'golf',
      layout: 'bun',
      target: '/Users/j/.bun/install/global/node_modules/golf/bin/golf.js',
      version: '7.0.0'
    },
    {
      binary: 'lima',
      layout: 'homebrew',
      target: '/opt/homebrew/Cellar/lima/1.0.0/bin/lima',
      version: 'lima 1.0.0'
    },
    {
      binary: 'juliet',
      layout: 'local-bin',
      target: '/Users/j/.local/bin/juliet',
      version: '10.0.0'
    },
    {
      binary: 'kilo',
      layout: 'login-shell',
      target: '/Users/j/.nvm/versions/node/v24.0.0/bin/kilo',
      version: 'kilo 11.0.0'
    }
  ],
  linux: [
    { binary: 'alpha', layout: 'path', target: '/opt/tools/bin/alpha', version: 'alpha 1.0.0' },
    {
      binary: 'bravo',
      layout: 'path-link',
      target: '/opt/tools/lib/node_modules/bravo/bin/bravo.js',
      version: '2.1.0'
    },
    {
      binary: 'delta',
      layout: 'npm',
      target: '/home/j/.npm-global/lib/node_modules/@acme/delta/cli.js',
      version: '4.0.0 (Delta)'
    },
    {
      binary: 'echo',
      layout: 'pnpm',
      target: '/home/j/.local/share/pnpm/echo',
      version: 'echo-cli 0.5.0'
    },
    { binary: 'foxtrot', layout: 'volta', target: '/home/j/.volta/bin/foxtrot', version: '6.0.0' },
    {
      binary: 'golf',
      layout: 'bun',
      target: '/home/j/.bun/install/global/node_modules/golf/bin/golf.js',
      version: '7.0.0'
    },
    {
      binary: 'juliet',
      layout: 'local-bin',
      target: '/home/j/.local/bin/juliet',
      version: '10.0.0'
    },
    {
      binary: 'kilo',
      layout: 'login-shell',
      target: '/home/j/.nvm/versions/node/v24.0.0/bin/kilo',
      version: 'kilo 11.0.0'
    }
  ]
}

function agyPlaces(platform: Platform): AgyPlaces {
  const home = FIXTURE_HOME[platform]
  const win = platform === 'win32'
  return {
    override: {
      binary: 'agy',
      layout: 'override',
      target: FIXTURE_AGY_OVERRIDE[platform],
      version: 'agy 1.1.26 (override)'
    },
    onPath: {
      binary: 'agy',
      layout: 'path',
      target: win ? 'C:\\Tools\\bin\\agy.exe' : '/opt/tools/bin/agy',
      version: 'agy 1.1.26 (path)'
    },
    localBin: {
      binary: 'agy',
      layout: 'local-bin',
      target: win ? `${home}\\.local\\bin\\agy.exe` : `${home}/.local/bin/agy`,
      version: 'agy 1.1.26 (local bin)'
    }
  }
}

export const AGY_PLACES: Readonly<Record<Platform, AgyPlaces>> = {
  win32: agyPlaces('win32'),
  darwin: agyPlaces('darwin'),
  linux: agyPlaces('linux')
}
