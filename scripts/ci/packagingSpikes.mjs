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

/** The URLs that fetch a spellcheck dictionary (Chromium's `.bdic` files under `/chrome/dict/`). */
export function dictionaryRequests(urls) {
  return urls.filter((url) => /\/dict\/|\.bdic(\?|$)/i.test(url))
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

/** `text` with each `[value, placeholder]` replaced, as written and as JSON-escaped (doubled backslashes). */
export function scrubText(text, replacements) {
  let out = text
  for (const [value, placeholder] of replacements) {
    if (!value) continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = out.split(spelling).join(placeholder)
    }
  }
  return out
}
