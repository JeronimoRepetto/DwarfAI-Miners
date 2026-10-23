import path from 'node:path'

/**
 * What keeps the demo off the person's real data (docs/demo.md "What the demo never touches"), checked before the app
 * starts and refused, with every reason named, when anything is wrong:
 *
 * - The profile is a fresh `dwarfai-demo-*` folder under the OS temp folder (`createIsolatedProfile`), which holds no
 *   real home.
 * - Every per-user and provider folder the app or its Host could read (`isolatedVariables`) points inside the profile:
 *   the E2E harness's `appEnv` sets them, and this check proves it for the environment actually handed over.
 * - No folder on the app's PATH outside the profile holds a provider CLI, so only the demo's stubs can be found and no
 *   real provider is ever started (the Claude entry prefers `claude-agent-acp` when it resolves, for example).
 * - Every mine folder is `<profile>/mines/<name>`, the name a plain lowercase word list.
 */

export const DEMO_PROFILE_PREFIX = 'dwarfai-demo-'

/** The variables naming a per-user or provider folder, per OS: the per-user data root of the Host's copy last. */
export function isolatedVariables(platform) {
  const common = [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME'
  ]
  if (platform === 'win32') return [...common, 'LOCALAPPDATA']
  if (platform === 'darwin') return common
  return [...common, 'XDG_DATA_HOME']
}

/** Whether `child` is `parent` or lies inside it. */
function inside(parent, child, api) {
  const relative = api.relative(api.resolve(parent), api.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative))
}

/** The value of `key` in `env`, whatever its spelling (Windows reads names without case). */
function valueOf(env, key) {
  const found = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase())
  return found === undefined ? undefined : env[found]
}

/**
 * Every reason the environment `env` would let the app leave `profile`, in words; empty when it is isolated.
 * `realHomes` are the person's own home folders, which the profile must never hold.
 */
export function isolationProblems(env, profile, { platform, realHomes, pathApi = path }) {
  const problems = []
  const roots = [profile.root, profile.dataRoot]
  if (!pathApi.basename(profile.root).startsWith(DEMO_PROFILE_PREFIX)) {
    problems.push(`the profile ${profile.root} is not a ${DEMO_PROFILE_PREFIX}* folder`)
  }
  for (const home of realHomes) {
    if (roots.some((root) => inside(root, home, pathApi))) {
      problems.push(`the profile ${profile.root} holds the real home ${home}`)
    }
  }
  for (const key of isolatedVariables(platform)) {
    const value = valueOf(env, key)
    if (value === undefined || value === '') problems.push(`${key} is not set`)
    else if (!roots.some((root) => inside(root, value, pathApi))) {
      problems.push(`${key} is ${value}, outside the demo profile`)
    }
  }
  return problems
}

/** The executable names of the provider CLIs the app could detect, without extension. */
export const PROVIDER_CLIS = Object.freeze([
  'claude',
  'claude-agent-acp',
  'codex',
  'codex-acp',
  'opencode',
  'antigravity',
  'agy',
  'gemini',
  'kimi',
  'claude-code-acp'
])

/**
 * Every folder of `pathValue` outside the profile that holds a provider CLI (with any of `pathExt`'s extensions, or
 * none), in words; empty when only the profile's stubs can be found.
 */
export function pathProblems(
  pathValue,
  profile,
  { platform, exists, pathExt = '', pathApi = path }
) {
  const delimiter = platform === 'win32' ? ';' : ':'
  const extensions = [
    '',
    ...pathExt
      .split(';')
      .filter((ext) => ext !== '')
      .map((ext) => ext.toLowerCase())
  ]
  const problems = []
  for (const folder of pathValue.split(delimiter).filter((entry) => entry !== '')) {
    if ([profile.root, profile.dataRoot].some((root) => inside(root, folder, pathApi))) continue
    const found = PROVIDER_CLIS.flatMap((name) => extensions.map((ext) => name + ext)).filter(
      (file) => exists(pathApi.join(folder, file))
    )
    if (found.length > 0) {
      problems.push(
        `PATH folder ${folder} holds a provider CLI (${found.join(', ')}): the demo would find it`
      )
    }
  }
  return problems
}

/**
 * The folder of the demo mine `name`: `<profile>/mines/<name>`. A name is letters, digits, spaces, hyphens and
 * apostrophes, starting and ending with a letter or digit (`Heigh-Ho Mine`, `ore-ledger`): never a separator, a dot or
 * a drive, so it can never leave the profile.
 */
export function mineFolderOf(profile, name, pathApi = path) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9 '-]*[A-Za-z0-9])?$/.test(name)) {
    throw new Error(`not a demo mine name: ${name}`)
  }
  return pathApi.join(profile.root, 'mines', name)
}

/** The provider CLIs that must resolve, and only to the demo's own stubs. */
export const REQUIRED_STUBS = Object.freeze(['claude', 'codex'])

/**
 * Where `name` resolves on `pathValue`, as the platform's lookup finds it: the first folder that holds it, trying each
 * `pathExt` extension in order on Windows (then the bare name), the bare name elsewhere. Null when nothing matches.
 */
export function resolveCommand(
  name,
  pathValue,
  { platform, exists, pathExt = '', pathApi = path }
) {
  const delimiter = platform === 'win32' ? ';' : ':'
  const extensions =
    platform === 'win32'
      ? [
          ...pathExt
            .split(';')
            .filter((ext) => ext !== '')
            .map((ext) => ext.toLowerCase()),
          ''
        ]
      : ['']
  for (const folder of pathValue.split(delimiter).filter((entry) => entry !== '')) {
    for (const ext of extensions) {
      const candidate = pathApi.join(folder, name + ext)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * The hard guard (docs/demo.md "The hard guard"): every provider CLI the app could detect, ACP adapters included,
 * resolved on the app's PATH as the platform resolves it. `claude` and `codex` must resolve inside the profile's
 * `stubs/` folder; any other must resolve there or nowhere. Every other outcome is named, and the demo refuses to start.
 * The Host inherits the app's environment, so a launch it makes later (a delegated worker included) resolves the same.
 */
export function resolutionProblems(pathValue, profile, options) {
  const { pathApi = path } = options
  const stubs = pathApi.join(profile.root, 'stubs')
  const problems = []
  for (const name of PROVIDER_CLIS) {
    const resolved = resolveCommand(name, pathValue, options)
    if (resolved === null) {
      if (REQUIRED_STUBS.includes(name)) problems.push(`${name} does not resolve to the demo stub`)
    } else if (!inside(stubs, resolved, pathApi)) {
      problems.push(`${name} resolves to ${resolved}, not to a demo stub`)
    }
  }
  return problems
}

/**
 * The CLIs each catalog provider can run as (`src/contracts/catalog/ids.mjs`), its ACP adapters included: whatever
 * provider a worker or a delegation lands on, its CLI is one the guard resolves.
 */
export const CATALOG_PROVIDER_CLIS = Object.freeze({
  claude: ['claude', 'claude-agent-acp', 'claude-code-acp'],
  codex: ['codex', 'codex-acp'],
  antigravity: ['antigravity', 'agy', 'gemini'],
  opencode: ['opencode']
})
