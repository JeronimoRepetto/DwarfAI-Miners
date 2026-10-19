// L8 OS lane (17 §1.8): the real boot identity of this machine, one describe per OS. Runs only in
// `pnpm test:os`. The annotation states the values, their sources and the OS version, as evidence
// the S-015-2 record can cite (that record has one writer, the cut-0 exit spike issue; this test
// does not write it).
import { release, version } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import { NodeProcessControl, createQueryRunner } from './NodeProcessControl'
import { createDarwinBootSources } from './bootIdentity/darwin'
import { createLinuxBootSources } from './bootIdentity/linux'
import { createWin32BootSources } from './bootIdentity/win32'

function sourcesOfThisOs(): Readonly<Record<string, string>> {
  const runQuery = createQueryRunner()
  if (process.platform === 'win32') return createWin32BootSources({ runQuery }).sources
  if (process.platform === 'darwin') return createDarwinBootSources({ runQuery }).sources
  return createLinuxBootSources().sources
}

function bootCases(): void {
  it("[S-015-2, FM-110] on this OS currentBootIdentity returns a bootId, a bootTimeMs before now and a logonSessionId, or 'unknown' for a field the OS does not expose", async ({
    annotate
  }) => {
    const control = new NodeProcessControl()

    const identity = await control.currentBootIdentity()
    const probed = await control.probe(process.pid)

    await annotate(
      `S-015-2 ${JSON.stringify({
        platform: process.platform,
        release: release(),
        version: version(),
        values: identity,
        sources: sourcesOfThisOs()
      })}`
    )
    expect(typeof identity.bootId).toBe('string')
    expect(identity.bootId).not.toBe('')
    if (identity.bootId !== 'unknown' && typeof probed === 'object') {
      expect(identity.bootId).toBe((probed as ProcessIdentity).bootId)
    }
    if (identity.bootTimeMs !== 'unknown') {
      expect(identity.bootTimeMs).toBeGreaterThan(0)
      expect(identity.bootTimeMs).toBeLessThan(Date.now())
    }
    expect(typeof identity.logonSessionId).toBe('string')
    expect(identity.logonSessionId).not.toBe('')
  }, 20_000)
}

describe.runIf(process.platform === 'win32')('currentBootIdentity on Windows', bootCases)
describe.runIf(process.platform === 'darwin')('currentBootIdentity on macOS', bootCases)
describe.runIf(process.platform === 'linux')('currentBootIdentity on Linux', bootCases)
