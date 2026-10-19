import { realpathSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from './launchApp.ts'
import { STUB_BIN, withStubs, type StubSetup } from './stubs.ts'

/**
 * L9 smoke of the stub-CLI kit (testing strategy `17` §1.9): with a stub first on `PATH`, the built
 * app's own environment resolves the provider's name to the stub, through the `.cmd` shim on
 * Windows and the executable wrapper on POSIX. Detection and observation of a replayed session need
 * the cut-1 Host; that smoke is the cut-1 switch's (later: ISSUE-123; review R7V-01).
 */

// A kit smoke runs once: a retry would hide a kit defect (17 §5.4).
test.describe.configure({ retries: 0 })

test.describe('stub CLI kit (17 §1.9)', () => {
  let launched: LaunchedApp | undefined
  let setup: StubSetup | undefined

  test.afterEach(async () => {
    await launched?.teardown()
    launched = undefined
    setup?.dispose()
    setup = undefined
  })

  test("[ADR-008] with the claude stub first on PATH the launched app's environment resolves claude to the stub", async () => {
    setup = withStubs(['claude'])
    launched = await launchApp({
      stubs: setup.stubs,
      env: setup.env,
      tracePath: test.info().outputPath('trace.zip')
    })

    // The platform's executable lookup, run inside the app's main process: each PATH directory in
    // order and, on Windows, each PATHEXT extension in order (cmd.exe's rule, SP-04).
    const resolved = await launched.app.evaluate((_electron, name) => {
      const fs = process.getBuiltinModule('node:fs')
      const nodePath = process.getBuiltinModule('node:path')
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
      const extensions =
        process.platform === 'win32'
          ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
          : ['']
      for (const dir of (process.env[pathKey] ?? '').split(nodePath.delimiter).filter(Boolean)) {
        for (const extension of extensions) {
          const candidate = nodePath.join(dir, name + extension.toLowerCase())
          if (fs.existsSync(candidate)) return candidate
        }
      }
      return null
    }, 'claude')

    const expected = path.join(
      realpathSync(STUB_BIN),
      'claude',
      process.platform === 'win32' ? 'claude.cmd' : 'claude'
    )
    expect(resolved, 'claude resolves on the app PATH').not.toBeNull()
    expect(realpathSync(resolved as string)).toBe(expected)
  })
})
