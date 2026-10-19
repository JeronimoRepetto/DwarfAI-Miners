import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostCopyRootFacts } from './versionedCopyRoot'

// L1 (17 §1.1): the copy root a Host accepts `host.upgrade.request.targetDir` under (14 §1.10) is
// the one its UI's launcher copies into (ADR-002 D5): the same rule, the same environment and the
// same build kind. Synthetic folders only (privacy-guard).

const ENV = { LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local', XDG_DATA_HOME: '/data/j' }

describe('hostCopyRootFacts (ADR-002 D5; ADR-005 item 6)', () => {
  it('[ADR-002, ADR-005, FM-107] a dev Host names host-dev and a release Host names host, side by side', () => {
    const dev = hostCopyRootFacts({ build: 'dev', env: ENV }).root
    const release = hostCopyRootFacts({ build: 'release', env: ENV }).root

    const paths = process.platform === 'win32' ? path.win32 : path.posix
    const split = (root: string | null) =>
      root === null ? null : { parent: paths.dirname(root), folder: paths.basename(root) }
    const parent = split(release)?.parent
    expect(split(dev)).toEqual({ parent, folder: 'host-dev' })
    expect(split(release)).toEqual({ parent, folder: 'host' })
  })
})
