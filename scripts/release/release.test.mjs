// layer: L7
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { releaseFlags } from './release-tag.mjs'

/**
 * The release job of CI (`20` §2.1 `release`, §3.2; `18` C-32, C-33, C-34; ISSUE-278).
 *
 * On a pushed `v*` tag, after every package leg and the licence report, the `release` job collects the installers of
 * the three OSes with the licence report and the SBOMs, writes `SHA256SUMS` over all of them and creates the GitHub
 * Release of the tag with GitHub's generated notes behind a fixed header. Owner decision 2026-10-20: the Release is
 * published, not a draft, and is Latest for a plain `vX.Y.Z` tag; a tag with a pre-release suffix is a pre-release.
 * Only this job holds `contents: write` and the protected `release` environment. The signed macOS build (ISSUE-280)
 * is deferred, so no job reads a signing secret.
 *
 * The workflow cannot run here, so its text is read.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const readWorkflow = (name) =>
  readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n')
const workflow = readWorkflow('ci.yml')

/** The workflow's text without comment lines, so prose never satisfies or trips an assertion. */
const withoutComments = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

/** Every top-level job of ci.yml, as `{ id, code }` with comment lines dropped. */
function jobs() {
  const code = withoutComments(workflow)
  const body = code.slice(code.indexOf('\njobs:\n'))
  const starts = [...body.matchAll(/\n {2}([a-z][\w-]*):\n/g)]
  return starts.map((match, i) => ({
    id: match[1],
    code: body.slice(match.index, i + 1 < starts.length ? starts[i + 1].index : undefined)
  }))
}

/** One job's code, comment lines dropped. */
function job(id) {
  const found = jobs().find((candidate) => candidate.id === id)
  expect(found, `ci.yml has a "${id}" job`).toBeDefined()
  return found.code
}

/** The job-level `if:` expression of a job, or null when it has none. */
function jobCondition(code) {
  const match = code.match(/\n {4}if: (?:>-?\n((?: {6}.*\n)+)|(.*)\n)/)
  return match === null ? null : (match[1] ?? match[2]).replace(/\s+/g, ' ').trim()
}

const SIGNING_SECRETS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
]

describe('release job in CI (20 §2.1 `release`; 18 C-32, C-33, C-34; ISSUE-278)', () => {
  it('[ADR-027] runs only on a pushed v* tag, after every package leg and the licence report, in the release environment with contents: write', () => {
    const code = job('release')
    expect(jobCondition(code)).toBe(
      "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
    )
    expect(code).toContain('\n    needs: [package, license-sbom]\n')
    expect(code).toContain('\n    environment: release\n')
    expect(code).toMatch(/\n {4}permissions:\n {6}contents: write\n {4}[a-z]/)
    expect(code).toContain('\n    runs-on: ubuntu-latest\n')
    const uses = [...code.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, 'pinned by commit SHA').toMatch(/@[0-9a-f]{40}$/)
  })

  it('[ADR-027] only the release job writes contents or enters the release environment, no job a pull request runs references a secret or a token, and no job reads a signing secret', () => {
    const all = jobs()
    expect(all.map(({ id }) => id)).toContain('release')
    for (const { id, code } of all) {
      if (id === 'release') continue
      expect(code, `${id} writes nothing`).not.toMatch(/: write\b/)
      expect(code, `${id} uses no environment`).not.toMatch(/\n {4}environment:/)
    }
    for (const { id, code } of all) {
      const condition = jobCondition(code)
      const runsOnPullRequest = condition === null || condition.includes('pull_request')
      if (!runsOnPullRequest) continue
      // The privacy guard's pattern is the one secret a pull request may read (the checks job); a fork's pull
      // request gets none and skips the guard.
      const secrets = [...code.matchAll(/\bsecrets\.(\w+)/g)].map((m) => m[1])
      expect(secrets, `${id} runs on a pull request and reads no other secret`).toEqual(
        secrets.filter((name) => name === 'PRIVACY_GUARD_PATTERN')
      )
      expect(code, `${id} runs on a pull request and holds no token`).not.toMatch(
        /github\.token|GH_TOKEN|GITHUB_TOKEN/
      )
    }
    const tokenHolders = all
      .filter(({ code }) => /github\.token|GH_TOKEN|GITHUB_TOKEN/.test(code))
      .map(({ id }) => id)
    expect(tokenHolders, 'only the release job holds the token').toEqual(['release'])
    for (const file of ['ci.yml', 'internal-build.yml']) {
      const code = withoutComments(readWorkflow(file))
      for (const name of SIGNING_SECRETS) {
        expect(code, `${file} reads no ${name} while ISSUE-280 is deferred`).not.toContain(name)
      }
    }
  })

  it('[ADR-027] collects the installers of the three OSes with the licence report and the SBOMs, then writes SHA256SUMS over every asset it publishes', () => {
    const code = job('release')
    const order = [
      'flags=$(node scripts/release/release-tag.mjs "$TAG")\n',
      'pattern: dwarfai-package-*\n',
      'name: license-sbom\n',
      'mkdir release-assets\n',
      'run: node scripts/ci/sha256sums.mjs release-assets .exe .zip .dmg .AppImage .deb .json\n',
      'gh release create'
    ].map((step) => code.indexOf(step))
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const pattern of [
      'artifacts/dwarfai-package-windows-latest/*-Setup-*-x64.exe',
      'artifacts/dwarfai-package-windows-latest/*-win-x64.zip',
      'artifacts/dwarfai-package-macos-15/*-arm64.dmg',
      'artifacts/dwarfai-package-macos-15/*-x64.dmg',
      'artifacts/dwarfai-package-macos-15/*-arm64.zip',
      'artifacts/dwarfai-package-macos-15/*[0-9]-x64.zip',
      'artifacts/dwarfai-package-ubuntu-latest/*.AppImage',
      'artifacts/dwarfai-package-ubuntu-latest/*.deb',
      'artifacts/license-sbom/licenses.json',
      'artifacts/license-sbom/sbom-*.json'
    ]) {
      expect(code, `the job requires ${pattern}`).toContain(`collect '${pattern}'\n`)
    }
    expect(code, 'a missing kind of asset fails the job').toMatch(/no release asset matches/)
    expect(code, 'two assets with one name fail the job').toMatch(/two release assets are named/)
  })

  it('[ADR-027] publishes the Release of the tag with the generated notes behind the fixed header, with the flags of the tag', () => {
    const code = job('release')
    expect(code).toContain(
      'gh release create "$TAG" release-assets/* --verify-tag --title "$TAG" --generate-notes --notes "$NOTES_HEADER" $RELEASE_FLAGS\n'
    )
    expect(code).toContain('GH_TOKEN: ${{ github.token }}\n')
    expect(code).toContain('TAG: ${{ github.ref_name }}\n')
    expect(code, 'never a draft').not.toMatch(/--draft/)
    expect(code).toContain('SHA256SUMS')
    expect(code).toContain('The Windows, macOS and Linux builds are unsigned.')
    expect(code, 'the tag reaches the shell only through the environment').not.toMatch(
      /run: .*\$\{\{ github\.ref_name \}\}/
    )
  })
})

describe('release tag flags (owner decision 2026-10-20; ISSUE-278)', () => {
  it('[ADR-027] a plain vX.Y.Z tag that matches package.json is published as Latest', () => {
    expect(releaseFlags('v0.20.1', '0.20.1')).toEqual(['--latest'])
  })

  it('[ADR-027] a tag with a pre-release suffix is published as a pre-release and never as Latest', () => {
    expect(releaseFlags('v0.21.0-rc.1', '0.21.0-rc.1')).toEqual(['--prerelease', '--latest=false'])
  })

  it('[ADR-027] a tag that differs from the package.json version or is not vX.Y.Z[-suffix] is refused', () => {
    expect(() => releaseFlags('v0.20.1', '0.20.0')).toThrow(/package\.json/)
    expect(() => releaseFlags('v0.20', '0.20')).toThrow(/vX\.Y\.Z/)
    expect(() => releaseFlags('0.20.1', '0.20.1')).toThrow(/vX\.Y\.Z/)
  })
})
