// layer: L7
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The packaged-artifact check runner (`20` §2.1 `package`, §2.3; ISSUE-268): `pnpm test:packaged [<artifact dir>]`
 * discovers every `p*.packaged.mjs` check beside it, runs each against the folder electron-builder wrote, prints one
 * line per P id and exits non-zero when any check fails. The runner is a real child process over real temporary
 * folders, the way the package job runs it.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const runner = path.join(here, 'run.mjs')
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Runs the runner and returns its exit code and output, never throwing on a non-zero exit. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [runner, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status, output: `${error.stdout}${error.stderr}` }
  }
}

/**
 * A checks folder holding only the real P-08 check, so its cases prove P-08 alone; every other real check (P-03
 * needs a packed app) has its own cases.
 */
function p08Only() {
  const checks = tempDir('packaged-checks-')
  copyFileSync(
    path.join(here, 'p08-names.packaged.mjs'),
    path.join(checks, 'p08-names.packaged.mjs')
  )
  return checks
}

/** A fake check module: its P id, and whether it passes, with the detail it reports. */
function fakeCheck(dir, file, { id, ok, detail }) {
  writeFileSync(
    path.join(dir, file),
    `export const id = ${JSON.stringify(id)}\n` +
      `export default async function check() {\n` +
      `  return { ok: ${ok}, detail: ${JSON.stringify(detail)} }\n` +
      `}\n`
  )
}

describe('packaged-artifact check runner (20 §2.3)', () => {
  it('[ADR-027] the runner reports each discovered P check by id and fails when one fails', () => {
    const checks = tempDir('packaged-checks-')
    const artifacts = tempDir('packaged-artifacts-')
    fakeCheck(checks, 'p01-fake.packaged.mjs', { id: 'P-01', ok: true, detail: 'fuses read back' })
    fakeCheck(checks, 'p02-fake.packaged.mjs', {
      id: 'P-02',
      ok: false,
      detail: 'no CSP in index.html'
    })
    // Not a P check: the runner discovers only `p*.packaged.mjs`.
    fakeCheck(checks, 'helper.mjs', { id: 'X-01', ok: false, detail: 'never run' })

    const failing = run([artifacts, '--checks', checks])

    expect(failing.code).toBe(1)
    expect(failing.output).toMatch(/^P-01 ok: fuses read back$/m)
    expect(failing.output).toMatch(/^P-02 FAIL: no CSP in index\.html$/m)
    expect(failing.output).not.toContain('X-01')

    rmSync(path.join(checks, 'p02-fake.packaged.mjs'))
    const passing = run([artifacts, '--checks', checks])
    expect(passing.code).toBe(0)
    expect(passing.output).toMatch(/^P-01 ok: fuses read back$/m)
  })

  it('[ADR-027] the runner fails when it finds no check or no artifact folder, so an empty run never passes', () => {
    const checks = tempDir('packaged-checks-')
    const artifacts = tempDir('packaged-artifacts-')

    expect(run([artifacts, '--checks', checks]).code).toBe(1)

    fakeCheck(checks, 'p01-fake.packaged.mjs', { id: 'P-01', ok: true, detail: 'ok' })
    expect(run([path.join(artifacts, 'missing'), '--checks', checks]).code).toBe(1)
  })

  it('[ADR-027] P-08 reports an artifact name with a space', () => {
    const artifacts = tempDir('packaged-artifacts-')
    writeFileSync(path.join(artifacts, 'DwarfAI-Miners-Setup-0.20.0-x64.exe'), '')
    writeFileSync(path.join(artifacts, 'DwarfAI-Miners-0.20.0-win-x64.zip'), '')

    const checks = p08Only()
    const green = run([artifacts, '--checks', checks])
    expect(green.code).toBe(0)
    expect(green.output).toMatch(/^P-08 ok: /m)

    writeFileSync(path.join(artifacts, 'DwarfAI Miners-Setup-0.20.0-x64.exe'), '')
    const red = run([artifacts, '--checks', checks])
    expect(red.code).toBe(1)
    expect(red.output).toMatch(/^P-08 FAIL: .*"DwarfAI Miners-Setup-0\.20\.0-x64\.exe"/m)
  })

  it('[ADR-027] P-08 fails when the folder holds no artifact at all', () => {
    const artifacts = tempDir('packaged-artifacts-')
    writeFileSync(path.join(artifacts, 'builder-debug.yml'), '')

    const result = run([artifacts, '--checks', p08Only()])
    expect(result.code).toBe(1)
    expect(result.output).toMatch(/^P-08 FAIL: no artifact/m)
  })

  it('[ADR-008] the runner runs P-03 beside P-08, and P-03 fails a folder that holds no packed app', () => {
    const artifacts = tempDir('packaged-artifacts-')
    writeFileSync(path.join(artifacts, 'DwarfAI-Miners-Setup-0.20.0-x64.exe'), '')

    const result = run([artifacts])

    expect(result.code).toBe(1)
    expect(result.output).toMatch(/^P-03 FAIL: no packed app \(app\.asar\) in /m)
    expect(result.output).toMatch(/^P-08 ok: /m)
  })

  it('[ADR-027] in release mode a missing or blocked P id fails the run and each present id is reported', () => {
    const checks = tempDir('packaged-checks-')
    const artifacts = tempDir('packaged-artifacts-')
    const required = path.join(tempDir('packaged-required-'), 'required.json')
    writeFileSync(
      required,
      JSON.stringify([
        { id: 'P-01', issue: 'ISSUE-269' },
        { id: 'P-02', issue: 'ISSUE-271' },
        { id: 'P-05', issue: 'ISSUE-270' }
      ])
    )
    fakeCheck(checks, 'p01-fake.packaged.mjs', { id: 'P-01', ok: true, detail: 'fuses read back' })
    // P-02 is present but blocked: its module throws instead of answering.
    writeFileSync(
      path.join(checks, 'p02-blocked.packaged.mjs'),
      `export const id = 'P-02'\nexport default async function check() {\n  throw new Error('no display')\n}\n`
    )

    const missing = run([artifacts, '--checks', checks, '--release', '--required', required])

    expect(missing.code).toBe(1)
    expect(missing.output).toMatch(/^P-01 ok: fuses read back$/m)
    expect(missing.output).toMatch(/^P-02 FAIL: threw no display$/m)
    expect(missing.output).toMatch(
      /^P-05 FAIL: missing, no p05-\*\.packaged\.mjs check; owned by ISSUE-270$/m
    )
    expect(missing.output).toMatch(/^P-02 .*owned by ISSUE-271$/m)

    // Without the flag the runner runs what is present, so today's package job is unchanged.
    const lenient = run([artifacts, '--checks', checks, '--required', required])
    expect(lenient.output).not.toContain('P-05')

    fakeCheck(checks, 'p02-blocked.packaged.mjs', { id: 'P-02', ok: true, detail: 'csp ok' })
    fakeCheck(checks, 'p05-fake.packaged.mjs', { id: 'P-05', ok: true, detail: 'host copy' })
    const complete = run([artifacts, '--checks', checks, '--release', '--required', required])
    expect(complete.code).toBe(0)
    expect(complete.output).toMatch(/^P-05 ok: host copy$/m)
  })

  it('[ADR-027] required.json names all nine P ids with the issue that owns each', () => {
    const required = JSON.parse(readFileSync(path.join(here, 'required.json'), 'utf8'))

    expect(required.map((entry) => entry.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `P-0${index + 1}`)
    )
    for (const entry of required) expect(entry.issue).toMatch(/^ISSUE-\d+$/)
  })
})
