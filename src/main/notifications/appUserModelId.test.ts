import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_USER_MODEL_ID, needsAppUserModelId } from './appUserModelId'

/**
 * The Windows half of #316's platform notes.
 *
 * Two separate claims, and only one of them is about an operating system. Which
 * platforms need the identity set from the process is a pure rule, asserted for
 * all three on this Windows host by passing the OS in (`platform-ports`). That
 * the identity MATCHES the installer's own is a cross-file consistency check,
 * and it reads package.json for the same reason scripts/sdkRuntimeVersions.
 * test.mjs does: the two values have no derivation between them, so nothing but
 * a test can notice them drifting apart.
 */

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'package.json'
)

describe('needsAppUserModelId', () => {
  it('is a Windows requirement and only a Windows one', () => {
    expect(needsAppUserModelId('win32')).toBe(true)
    expect(needsAppUserModelId('darwin')).toBe(false)
    expect(needsAppUserModelId('linux')).toBe(false)
  })
})

describe('APP_USER_MODEL_ID', () => {
  it("is exactly the installer's appId, or a dev build's notifications go nowhere", () => {
    // Windows attributes a toast to this identity. A packaged build inherits
    // it from the shortcut the installer wrote, which is built from
    // `build.appId`; a dev build has no shortcut and states it here. The two
    // drifting apart would put a development build's notifications under a
    // second identity in the Action Center — where a person turns them off per
    // app — while every assertion in this repo went on passing.
    const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const appId = (
      (pkg as { build?: Record<string, unknown> }).build as { appId?: unknown } | undefined
    )?.appId
    expect(typeof appId).toBe('string')
    expect(APP_USER_MODEL_ID).toBe(appId)
  })
})
