// The child environment of `15` §4 (`childEnv(spawnTag)`, frozen): an explicit allowlist, never
// the Host environment minus a denylist. It is built fresh from named variables of the person's
// login environment and holds exactly two DwarfAI-set values: `DWARFAI_SPAWN` (ADR-015 item 2)
// and, with a loopback MCP relay, the `NO_PROXY`/`no_proxy` loopback addition (ADR-013 item 3).
// No Host/Electron-internal variable, no other `DWARFAI_*` value and no DwarfAI secret or
// delegation credential can reach a child (ADR-013 item 2, ADR-017 item 3, `18` C-16). It is
// applied to every process DwarfAI starts for a session: the provider CLI, an adapter process and
// the CLI an in-process library spawns. Never reads `process.env`: the caller passes the login
// environment in.
import { HostInvariantError } from '../../../../../kernel/domain/errors'

export type LoginEnvironment = Readonly<Record<string, string | undefined>>

export interface ChildEnvOptions {
  /** The provider's own documented configuration variables, recorded with its catalog record. */
  readonly providerVars: readonly string[]
  /** A loopback MCP relay is injected into this launch (ADR-013 item 3). */
  readonly loopbackRelay: boolean
  readonly platform: NodeJS.Platform
}

/** Copied from the login environment on every OS when set (`15` §4). */
const COMMON_NAMES: readonly string[] = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR'
]

/** Copied only on Windows (`15` §4). */
const WINDOWS_NAMES: readonly string[] = ['SystemRoot', 'ComSpec', 'PATHEXT']

/** `LANG` and `LC_*` (`15` §4): every locale category variable. */
const LOCALE_PREFIX = 'LC_'

const SPAWN_VARIABLE = 'DWARFAI_SPAWN'
const SPAWN_TAG_SHAPE = /^v1:[^:]+:[^:]+:[^:]+$/
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1']
const NO_PROXY_NAMES: readonly string[] = ['NO_PROXY', 'no_proxy']

/** Names no provider record may add back: the Host's own and DwarfAI's (`15` §4). */
function isReservedName(name: string): boolean {
  const upper = name.toUpperCase()
  return upper.startsWith('DWARFAI_') || upper.startsWith('ELECTRON_') || upper === 'NODE_OPTIONS'
}

export function childEnv(
  loginEnv: LoginEnvironment,
  spawnTag: string,
  opts: ChildEnvOptions
): Record<string, string> {
  if (!SPAWN_TAG_SHAPE.test(spawnTag)) {
    throw new HostInvariantError(
      'a spawn tag is v1:<installId>:<launchId>:<hostEpoch> (ADR-015 item 2)'
    )
  }
  const reserved = opts.providerVars.filter(isReservedName)
  if (reserved.length > 0) {
    throw new HostInvariantError(
      `a provider's documented variables never name a Host or DwarfAI variable: ${reserved.join(', ')}`
    )
  }

  const windows = opts.platform === 'win32'
  const names = new Set<string>([
    ...COMMON_NAMES,
    ...(windows ? WINDOWS_NAMES : []),
    ...opts.providerVars
  ])
  // Windows environment names are case-insensitive: match without case, keep the login spelling.
  const listed = windows ? new Set([...names].map((name) => name.toUpperCase())) : names
  const isListed = (name: string): boolean =>
    listed.has(windows ? name.toUpperCase() : name) ||
    (windows ? name.toUpperCase() : name).startsWith(LOCALE_PREFIX)

  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(loginEnv)) {
    if (value !== undefined && isListed(name)) env[name] = value
  }

  if (opts.loopbackRelay) {
    for (const name of NO_PROXY_NAMES) env[name] = withLoopback(env[name])
  }
  env[SPAWN_VARIABLE] = spawnTag
  return env
}

/** The login `NO_PROXY` value plus each loopback host it does not already list. */
function withLoopback(current: string | undefined): string {
  const entries = (current ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  for (const host of LOOPBACK_HOSTS) if (!entries.includes(host)) entries.push(host)
  return entries.join(',')
}
