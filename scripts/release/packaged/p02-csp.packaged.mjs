// P-02 (`20` §2.3; ADR-019 item 4; `18` C-03; ISSUE-271): every window's packaged `index.html` carries the
// Content-Security-Policy with `connect-src 'self'` and no `ws://` dev origin. A window's page is an `.html` file of
// the app's own code in `app.asar` (the renderer build, `out/renderer/index.html`); the dev server's HMR websocket
// origin joins `connect-src` only for an unpackaged app (`window/adapters/contentSecurityPolicy.ts`), so it must be in
// no packed page. Each page has exactly one policy, whose `connect-src` lists `'self'` alone; any websocket origin or
// local address anywhere in it fails. A folder with no packed app, or an app with no page, fails, so a broken build
// never passes. It reads files only.
import { findAppAsars, openAsar, relativeTo } from './apps.mjs'

export const id = 'P-02'

/** The `content` of every `<meta http-equiv="Content-Security-Policy">` tag of `html`, in any attribute order. */
function policiesOf(html) {
  const policies = []
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attribute = (name) =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
    const equiv = attribute('http-equiv')
    if ((equiv?.[1] ?? equiv?.[2] ?? '').toLowerCase() !== 'content-security-policy') continue
    const content = attribute('content')
    policies.push(content?.[1] ?? content?.[2] ?? '')
  }
  return policies
}

/** The problems of one page's policies against ADR-019 item 4; empty when it holds. */
function problemsOf(policies) {
  if (policies.length === 0) return ['no Content-Security-Policy meta tag']
  if (policies.length > 1)
    return [`${policies.length} Content-Security-Policy meta tags, expected one`]
  const [policy] = policies
  const problems = []
  const connect = policy
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name?.toLowerCase() === 'connect-src')
  if (connect === undefined) problems.push("no connect-src directive, expected connect-src 'self'")
  else if (connect.length !== 2 || connect[1] !== "'self'") {
    problems.push(`connect-src is "${connect.slice(1).join(' ')}", expected 'self' alone`)
  }
  for (const origin of policy.match(/\bwss?:\/\/[^\s;]*/gi) ?? []) {
    problems.push(`websocket origin ${origin}`)
  }
  for (const local of policy.match(/\b(?:localhost|127\.0\.0\.1|\[::1\])[^\s;]*/gi) ?? []) {
    problems.push(`local origin ${local}`)
  }
  return problems
}

export default async function check({ artifactDir }) {
  const asars = await findAppAsars(artifactDir)
  if (asars.length === 0) return { ok: false, detail: `no packed app (app.asar) in ${artifactDir}` }
  const failures = []
  const passed = []
  for (const file of asars) {
    const archive = await openAsar(file)
    const pages = archive.paths.filter(
      (entry) => entry.toLowerCase().endsWith('.html') && !entry.split('/').includes('node_modules')
    )
    const where = relativeTo(artifactDir, file)
    if (pages.length === 0) {
      failures.push(`${where}: no window page (.html) in the archive`)
      continue
    }
    for (const page of pages) {
      const problems = problemsOf(policiesOf(archive.text(page)))
      if (problems.length > 0) failures.push(`${where}!${page}: ${problems.join(', ')}`)
      else passed.push(`${where}!${page}`)
    }
  }
  if (failures.length > 0) return { ok: false, detail: failures.join('; ') }
  return {
    ok: true,
    detail: `${passed.length} window pages carry the CSP with connect-src 'self' and no ws:// origin: ${passed.join(', ')}`
  }
}
