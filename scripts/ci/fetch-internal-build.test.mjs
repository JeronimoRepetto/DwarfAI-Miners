// layer: L7
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fetchInternalBuild,
  parseArtifactList,
  parseRunArgs,
  planFetch
} from './fetch-internal-build.mjs'

// The owner's side of an internal build (.github/workflows/internal-build.yml): download a run's artifacts, verify
// each against its SHA256SUMS, then delete them from GitHub at once, because the repository is public and every
// signed-in user could download them (OQ-66: no public build before cut 5). `gh` sits behind an injected runner, so
// no test here ever runs the real `gh` or touches the network.

const sha = (text) => createHash('sha256').update(text).digest('hex')
const RUN = '4242'
const LIST = `repos/{owner}/{repo}/actions/runs/${RUN}/artifacts?per_page=100`

let root
let folder
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fetch-internal-build-'))
  folder = path.join(root, 'downloads')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Two artifacts as the internal-build workflow uploads them: installers plus their SHA256SUMS. */
function artifacts() {
  return [
    { id: 11, name: 'dwarfai-internal-cut-0-windows', files: { 'Setup.exe': 'setup' } },
    { id: 12, name: 'dwarfai-internal-cut-0-linux', files: { 'a.AppImage': 'a', 'b.deb': 'b' } }
  ]
}

/** A scriptable `gh`: answers the artifact list, writes each artifact on download, and records every call. */
function fakeGh(published, { tamper, failDownload, failDelete } = {}) {
  const calls = []
  const gh = (args) => {
    calls.push(args)
    if (args[0] === 'api' && args[1] === LIST) {
      return {
        status: 0,
        stdout: JSON.stringify({
          total_count: published.length,
          artifacts: published.map(({ id, name, expired }) => ({ id, name, expired: !!expired }))
        }),
        stderr: ''
      }
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const name = args[args.indexOf('--name') + 1]
      if (name === failDownload) return { status: 1, stdout: '', stderr: 'no artifact matches' }
      const dir = args[args.indexOf('--dir') + 1]
      const artifact = published.find((a) => a.name === name)
      mkdirSync(dir, { recursive: true })
      const lines = []
      for (const [file, content] of Object.entries(artifact.files)) {
        writeFileSync(path.join(dir, file), tamper === file ? `${content}!` : content)
        lines.push(`${sha(content)}  ${file}`)
      }
      writeFileSync(path.join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`)
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
      if (failDelete && args[3].endsWith(`/${failDelete}`)) {
        return { status: 1, stdout: '', stderr: 'HTTP 403' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  return { gh, calls }
}

const deletes = (calls) => calls.filter((args) => args.includes('DELETE'))

describe('fetch-internal-build', () => {
  it('[ADR-027] takes a numeric run id and a target folder, and nothing else', () => {
    expect(parseRunArgs([RUN, 'out'])).toEqual({ runId: RUN, folder: 'out' })
    expect(() => parseRunArgs(['abc', 'out'])).toThrow(/usage/)
    expect(() => parseRunArgs([RUN])).toThrow(/usage/)
    expect(() => parseRunArgs([RUN, 'out', 'more'])).toThrow(/usage/)
  })

  it('[ADR-027] reads the run artifact list and fails on an answer that is not one', () => {
    expect(
      parseArtifactList(
        JSON.stringify({ artifacts: [{ id: 7, name: 'x', expired: false, size_in_bytes: 1 }] })
      )
    ).toEqual([{ id: 7, name: 'x', expired: false }])
    expect(() => parseArtifactList('{"message":"Not Found"}')).toThrow(/artifact list/)
  })

  it('[ADR-027] plans one gh download per artifact into its own folder, and one artifact delete per artifact', () => {
    const plan = planFetch({
      runId: RUN,
      folder: 'out',
      artifacts: [{ id: 11, name: 'dwarfai-internal-cut-0-windows', expired: false }]
    })
    expect(plan.downloads).toEqual([
      {
        name: 'dwarfai-internal-cut-0-windows',
        dir: path.join('out', 'dwarfai-internal-cut-0-windows'),
        args: [
          'run',
          'download',
          RUN,
          '--name',
          'dwarfai-internal-cut-0-windows',
          '--dir',
          path.join('out', 'dwarfai-internal-cut-0-windows')
        ]
      }
    ])
    expect(plan.deletes).toEqual([
      {
        id: 11,
        name: 'dwarfai-internal-cut-0-windows',
        args: ['api', '-X', 'DELETE', 'repos/{owner}/{repo}/actions/artifacts/11']
      }
    ])
  })

  it('[ADR-027] downloads, verifies and then deletes every artifact of the run, printing what it did', () => {
    const { gh, calls } = fakeGh(artifacts())
    const lines = []
    const result = fetchInternalBuild({ runId: RUN, folder, gh, log: (l) => lines.push(l) })
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
    expect(result.downloaded).toEqual([
      path.join('dwarfai-internal-cut-0-windows', 'Setup.exe'),
      path.join('dwarfai-internal-cut-0-linux', 'a.AppImage'),
      path.join('dwarfai-internal-cut-0-linux', 'b.deb')
    ])
    expect(result.deleted).toEqual([
      'dwarfai-internal-cut-0-windows',
      'dwarfai-internal-cut-0-linux'
    ])
    expect(deletes(calls).map((args) => args[3])).toEqual([
      'repos/{owner}/{repo}/actions/artifacts/11',
      'repos/{owner}/{repo}/actions/artifacts/12'
    ])
    // Every download is verified before the first delete.
    const firstDelete = calls.findIndex((args) => args.includes('DELETE'))
    const lastDownload = calls.findLastIndex((args) => args[1] === 'download')
    expect(lastDownload).toBeLessThan(firstDelete)
    const output = lines.join('\n')
    expect(output).toContain(`verified ${path.join('dwarfai-internal-cut-0-linux', 'b.deb')}`)
    expect(output).toContain('deleted artifact dwarfai-internal-cut-0-windows (id 11)')
    expect(existsSync(path.join(folder, 'dwarfai-internal-cut-0-linux', 'b.deb'))).toBe(true)
  })

  it('[ADR-027] refuses and deletes nothing when any file fails its checksum, keeping the artifacts on GitHub', () => {
    const { gh, calls } = fakeGh(artifacts(), { tamper: 'b.deb' })
    const result = fetchInternalBuild({ runId: RUN, folder, gh, log: () => {} })
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(['dwarfai-internal-cut-0-linux: b.deb: checksum mismatch'])
    expect(result.deleted).toEqual([])
    expect(deletes(calls)).toEqual([])
  })

  it('[ADR-027] refuses and deletes nothing when a download fails or an artifact has expired', () => {
    const failing = fakeGh(artifacts(), { failDownload: 'dwarfai-internal-cut-0-linux' })
    const result = fetchInternalBuild({ runId: RUN, folder, gh: failing.gh, log: () => {} })
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'dwarfai-internal-cut-0-linux: gh run download failed: no artifact matches'
    ])
    expect(deletes(failing.calls)).toEqual([])

    const expired = artifacts()
    expired[0].expired = true
    const old = fakeGh(expired)
    const second = fetchInternalBuild({
      runId: RUN,
      folder: path.join(root, 'second'),
      gh: old.gh,
      log: () => {}
    })
    expect(second.ok).toBe(false)
    expect(second.problems).toEqual(['dwarfai-internal-cut-0-windows: expired on GitHub'])
    expect(old.calls.filter((args) => args[0] === 'run')).toEqual([])
    expect(deletes(old.calls)).toEqual([])
  })

  it('[ADR-027] refuses a run without artifacts and a target folder that is not empty, before downloading', () => {
    const none = fakeGh([])
    const empty = fetchInternalBuild({ runId: RUN, folder, gh: none.gh, log: () => {} })
    expect(empty.ok).toBe(false)
    expect(empty.problems).toEqual([`run ${RUN} has no artifacts`])

    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'stale.exe'), 'old')
    const { gh, calls } = fakeGh(artifacts())
    const result = fetchInternalBuild({ runId: RUN, folder, gh, log: () => {} })
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([`${folder} is not empty`])
    expect(calls).toEqual([])
    expect(readdirSync(folder)).toEqual(['stale.exe'])
  })

  it('[ADR-027] reports an artifact it could not delete and still deletes the others', () => {
    const { gh, calls } = fakeGh(artifacts(), { failDelete: 11 })
    const result = fetchInternalBuild({ runId: RUN, folder, gh, log: () => {} })
    expect(result.ok).toBe(false)
    expect(result.deleted).toEqual(['dwarfai-internal-cut-0-linux'])
    expect(result.problems).toEqual([
      'dwarfai-internal-cut-0-windows: delete failed (id 11): HTTP 403'
    ])
    expect(deletes(calls)).toHaveLength(2)
  })
})
