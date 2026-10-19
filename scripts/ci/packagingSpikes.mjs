// Pure helpers of the packaging spike lane (.github/workflows/spikes-package.yml; ISSUE-328). The harnesses under
// spikes/S-019-3, spikes/S-027-1 and spikes/S-027-3 and the workflow call them; they read and write nothing.

/** The version the upgrade build of S-027-3 and S-027-1 packages: the next patch, without a pre-release tag. */
export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) throw new Error(`${version} is not a semantic version`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

const HOOKS = ['pre_install', 'post_install', 'pre_uninstall', 'post_uninstall']

/**
 * A Scoop manifest for a local zip (S-027-1). Each install and uninstall hook appends one JSON line to `hookLog` with
 * the variables a hook can read (`$cmd`, `$app`, `$version`, `$global`, `$dir`) and the PowerShell command line, so
 * the record shows whether `scoop update` runs `pre_uninstall` and how a hook can tell an update from an uninstall
 * (OQ-59). `hookLog` goes into single-quoted PowerShell strings, so a path with a quote is refused.
 */
export function scoopManifest({ version, url, hash, executable, hookLog }) {
  if (hookLog.includes("'")) throw new Error('the hook log path must not contain a quote')
  const hook = (name) => [
    `$entry = [ordered]@{ hook = '${name}'; cmd = "$cmd"; app = "$app"; version = "$version"; ` +
      `global = "$global"; dir = "$dir"; commandLine = [Environment]::CommandLine; ` +
      `at = (Get-Date).ToUniversalTime().ToString('o') }`,
    `Add-Content -LiteralPath '${hookLog}' -Value ($entry | ConvertTo-Json -Compress)`
  ]
  const manifest = {
    version,
    description: 'DwarfAI-Miners packaging spike S-027-1 (local zip, never published)',
    homepage: 'https://github.com/JeronimoRepetto/DwarfAI-Miners',
    license: 'GPL-3.0-or-later',
    url,
    hash,
    shortcuts: [[executable, executable.replace(/\.exe$/i, '')]]
  }
  for (const name of HOOKS) manifest[name] = hook(name)
  return manifest
}

/**
 * The distinct request URLs of a Chromium net log (`--log-net-log`), in first-seen order. The log is read as text,
 * so a file cut off when the app was ended still yields the URLs written before the cut.
 */
export function netLogUrls(text) {
  const urls = []
  for (const match of text.matchAll(/"url":"((?:[^"\\]|\\.)*)"/g)) {
    const url = JSON.parse(`"${match[1]}"`)
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

/**
 * The URLs that fetch a spellcheck dictionary (Chromium's `.bdic` files under `/chrome/dict/`), without their query:
 * the CDN's redirect carries the client's public IP in it (`mip=`).
 */
export function dictionaryRequests(urls) {
  return urls.filter((url) => /\/dict\/|\.bdic(\?|$)/i.test(url)).map((url) => url.split('?')[0])
}

/** The sorted distinct hosts of the http(s) URLs. */
export function hostsOf(urls) {
  const hosts = new Set()
  for (const url of urls) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') hosts.add(parsed.hostname)
    } catch {
      // Not a URL.
    }
  }
  return [...hosts].sort()
}

/**
 * The `tar` that reads a zip. On Windows that is the system's bsdtar (`%SystemRoot%\System32\tar.exe`): the `tar`
 * first on PATH in the workflow's bash step is Git's GNU tar, which reads `D:\...` as a remote host and reads no zip.
 */
export function tarCommand(platform, env) {
  if (platform !== 'win32') return 'tar'
  return `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe`
}

/**
 * The install folder of an uninstall registry entry: its `InstallLocation`, or else the folder of the uninstaller its
 * `UninstallString` names (electron-builder's per-user nsis installer writes no `InstallLocation`). Null when neither
 * names one.
 */
export function installDirOf(entry) {
  if (entry?.InstallLocation) return entry.InstallLocation
  const command = entry?.UninstallString
  if (!command) return null
  const file = (/^"([^"]+)"/.exec(command) ?? /^(\S+)/.exec(command))?.[1]
  if (!file) return null
  const cut = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return cut > 0 ? file.slice(0, cut) : null
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `text` with each `[value, placeholder, options]` replaced, as written and as JSON-escaped (doubled backslashes).
 * With `{ word: true }` a value is replaced only where it stands alone, not inside a longer word (a user named
 * `runner` leaves the key `runnerOs` alone).
 */
export function scrubText(text, replacements) {
  let out = text
  for (const [value, placeholder, options = {}] of replacements) {
    if (!value) continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = options.word
        ? out.replace(
            new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(spelling)}(?![A-Za-z0-9_])`, 'g'),
            () => placeholder
          )
        : out.split(spelling).join(placeholder)
    }
  }
  return out
}

/**
 * The tray processes a Host started from its own versioned copy (ADR-018 D5: with no `ui` or `notifier` client
 * attached, the Host starts its own executable `--background`, ADR-002 D7): the main process of an app run from under
 * `copyRoot` with `--background`, never the Host (`hostPid`) and never an Electron helper (`--type=`). That tray
 * holds the app's single-instance lock (ADR-002 D3), so a later launch of an upgraded app hands itself over to it.
 */
export function trayProcessesOf(list, { copyRoot, hostPid }) {
  const root = copyRoot.toLowerCase().replace(/[\\/]+$/, '')
  return list.filter((p) => {
    if (p.pid === hostPid) return false
    const executable = (p.executable ?? '').toLowerCase()
    if (!executable.startsWith(`${root}\\`) && !executable.startsWith(`${root}/`)) return false
    const args = p.commandLine ?? ''
    return /(^|\s)--background(\s|$)/.test(args) && !/(^|\s)--type=/.test(args)
  })
}

/**
 * The UI records of app version `version` in a product log's text (ADR-026 JSON lines), each as
 * `{ event, outcome, causeClass }`: what the upgraded UI did. A torn last line or a blank one is skipped.
 */
export function uiRecordsOf(text, version) {
  const records = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.proc !== 'ui' || entry.appVersion !== version) continue
    records.push({ event: entry.event, outcome: entry.outcome, causeClass: entry.causeClass })
  }
  return records
}
