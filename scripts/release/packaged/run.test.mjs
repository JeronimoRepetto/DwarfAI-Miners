// layer: L7
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

    const green = run([artifacts])
    expect(green.code).toBe(0)
    expect(green.output).toMatch(/^P-08 ok: /m)

    writeFileSync(path.join(artifacts, 'DwarfAI Miners-Setup-0.20.0-x64.exe'), '')
    const red = run([artifacts])
    expect(red.code).toBe(1)
    expect(red.output).toMatch(/^P-08 FAIL: .*"DwarfAI Miners-Setup-0\.20\.0-x64\.exe"/m)
  })

  it('[ADR-027] P-08 fails when the folder holds no artifact at all', () => {
    const artifacts = tempDir('packaged-artifacts-')
    writeFileSync(path.join(artifacts, 'builder-debug.yml'), '')

    const result = run([artifacts])
    expect(result.code).toBe(1)
    expect(result.output).toMatch(/^P-08 FAIL: no artifact/m)
  })
})
