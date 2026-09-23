import { posix, win32 } from 'node:path'
import { currentPlatform, type Platform } from '../platform/platform'

/**
 * Where the built `jevMcpServer.js` (electron-vite's second `main` entry,
 * `electron.vite.config.ts`) lives at runtime, and how a CLI this app
 * launches should spawn it (#511 T4).
 *
 * ## The packaged-build decision: `app.asar.unpacked`, not asar
 *
 * `jevMcpServer.ts`'s own header comment (T2) flags this as an open risk:
 * whether a process started with `ELECTRON_RUN_AS_NODE=1` can even resolve a
 * script path INSIDE an asar archive is unmeasured. This app spawns the
 * server as `process.execPath <script>` — a plain argv, not a `require()` —
 * so what is actually being asked is whether Node's own bootstrap can
 * `fs.readFileSync` an entry file living inside `app.asar`. No authoritative
 * source for that specific case (an asar-relative SCRIPT ARGUMENT under
 * `ELECTRON_RUN_AS_NODE`, as opposed to a `require()` from application code)
 * was found, so this resolves the packaged path under
 * `resources/app.asar.unpacked/` and package.json's own `build.asarUnpack`
 * lists `out/main/jevMcpServer.js` to put it there — the safe default this
 * task's own instructions name, kept rather than an unverified shortcut.
 * `out/main/index.js` (the app itself) is unaffected: it stays inside the
 * asar, exactly as before, because Electron's own bootstrap (not a plain
 * Node one) is what loads it.
 *
 * ## Dev
 *
 * Alongside `out/main/index.js` at the project root — the same
 * `electron-vite build` output every dev run already reads the app entry
 * from, so no separate copy step is needed for the server script either.
 *
 * Pure, on the same terms `resourcePaths.ts`/`terminalLauncher.ts`
 * (`resolveViewerScriptPath`) already are: a `Platform` parameter picks the
 * join style, never `process.platform` (`platform-ports`), so dev/packaged
 * and all three OS path shapes are asserted on any host.
 */
export interface DelegationServerPathOptions {
  isPackaged: boolean
  /** process.resourcesPath — used only when packaged. */
  resourcesPath: string
  /** app.getAppPath() (the project root pre-package, i.e. in dev). */
  appPath: string
}

/** The one build output this resolves — see `electron.vite.config.ts`'s `jevMcpServer` entry. */
const SERVER_SCRIPT_SEGMENTS = ['out', 'main', 'jevMcpServer.js'] as const

/**
 * The build's own unpacked-asar segment, joined between `resourcesPath` and
 * the script's own path in a packaged build. Named as a constant rather than
 * inlined so `package.json`'s own `build.asarUnpack` entry and this resolver
 * are the two places the convention is stated, not three.
 */
const ASAR_UNPACKED_SEGMENT = 'app.asar.unpacked'

export function resolveDelegationServerScriptPath(
  options: DelegationServerPathOptions,
  platform: Platform = currentPlatform()
): string {
  const join = platform === 'win32' ? win32.join : posix.join
  return options.isPackaged
    ? join(options.resourcesPath, ASAR_UNPACKED_SEGMENT, ...SERVER_SCRIPT_SEGMENTS)
    : join(options.appPath, ...SERVER_SCRIPT_SEGMENTS)
}

/** How a launched CLI should spawn the delegation server, as an MCP stdio `command`/`args` pair. */
export interface DelegationServerCommand {
  command: string
  args: string[]
}

/**
 * `process.execPath` as `command` — the same Electron binary this app is
 * already running as, restarted plain-Node-only by the `ELECTRON_RUN_AS_NODE`
 * env `delegationInjection.ts` places on the server's own env map (never on
 * the CLI's), rather than a separately installed `node` this build cannot
 * assume exists on the machine.
 */
export function resolveDelegationServerCommand(
  options: DelegationServerPathOptions,
  execPath: string,
  platform: Platform = currentPlatform()
): DelegationServerCommand {
  return { command: execPath, args: [resolveDelegationServerScriptPath(options, platform)] }
}
