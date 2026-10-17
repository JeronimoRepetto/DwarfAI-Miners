// The ConsoleResolver contract over the real adapter (per-test temp dir) and its double, and the
// adapter's own file rules (ADR-003 item 12).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId } from '../../../../kernel/domain/values'
import { consolePlan, type ConsoleSession } from '../../application/resolveConsole'
import { runConsoleResolverContract } from './consoleResolver.contract'
import { FakeConsoleResolver } from './FakeConsoleResolver'
import { HostConsoleResolver } from './HostConsoleResolver'
import { RunDirViewerTokenFiles } from './RunDirViewerTokenFiles'
import { VIEW_TOKEN_TTL_MS, ViewTokenRegistry } from './ViewTokenRegistry'
import { parseViewerTokenFile } from './viewer/viewerTokenFile'

const LAUNCHED = '01920000-0000-7000-9000-0000000000a1' as DwarfId
const OBSERVED = '01920000-0000-7000-9000-0000000000a2' as DwarfId
const OBSERVED_NO_PROCESS = '01920000-0000-7000-9000-0000000000a3' as DwarfId
const UNKNOWN = '01920000-0000-7000-9000-0000000000a4' as DwarfId
const PROCESS = { pid: 4242, processStartTimeMs: 1_700_000_000_000, bootId: 'boot-1' }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function real(clock = new FakeClock(5_000)) {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-viewer-'))
  roots.push(root)
  const sessions = new Map<DwarfId, ConsoleSession>([
    [LAUNCHED, { owned: true, process: PROCESS }],
    [OBSERVED, { owned: false, process: PROCESS }],
    [OBSERVED_NO_PROCESS, { owned: false, process: null }]
  ])
  const tokens = new ViewTokenRegistry({ clock, ids: new SequenceIdGenerator() })
  const issued: string[] = []
  const recording = {
    issue: (dwarfId: DwarfId) => {
      const view = tokens.issue(dwarfId)
      issued.push(view.token)
      return view
    },
    dropExpired: () => tokens.dropExpired()
  }
  const resolver = new HostConsoleResolver({
    sessions: { sessionOf: (dwarfId) => sessions.get(dwarfId) ?? null },
    plan: consolePlan,
    tokens: recording,
    files: new RunDirViewerTokenFiles({ hostDataDir: root }),
    viewer: {
      program: join(root, 'app', 'dwarfai'),
      entry: join(root, 'out', 'host', 'dwarfai-viewer.js'),
      cwd: root
    }
  })
  return { root, resolver, tokens, issued, clock }
}

runConsoleResolverContract('HostConsoleResolver', () => {
  const r = real()
  return {
    resolver: r.resolver,
    launched: LAUNCHED,
    observed: OBSERVED,
    observedNoProcess: OBSERVED_NO_PROCESS,
    unknown: UNKNOWN,
    observedProcess: { pid: PROCESS.pid, startTime: PROCESS.processStartTimeMs },
    secrets: () => r.issued
  }
})

runConsoleResolverContract('FakeConsoleResolver', () => {
  const fake = new FakeConsoleResolver(
    new Map([
      [LAUNCHED, { owned: true, process: null }],
      [OBSERVED, { owned: false, process: { pid: 7, startTime: 70 } }],
      [OBSERVED_NO_PROCESS, { owned: false, process: null }]
    ])
  )
  return {
    resolver: fake,
    launched: LAUNCHED,
    observed: OBSERVED,
    observedNoProcess: OBSERVED_NO_PROCESS,
    unknown: UNKNOWN,
    observedProcess: { pid: 7, startTime: 70 },
    secrets: () => fake.issuedTokens
  }
})

describe('HostConsoleResolver', () => {
  it('[ADR-003] the credential file of a target holds that view token, which the registry accepts once', async () => {
    const r = real()
    const target = await r.resolver.targetFor(LAUNCHED)
    const path = target.credentialFile ?? ''

    expect(path.startsWith(join(r.root, 'run', 'viewers'))).toBe(true)
    const token = parseViewerTokenFile(readFileSync(path, 'utf8'))?.token ?? ''
    expect(token).toBe(r.issued[0])
    expect(parseViewerTokenFile(readFileSync(path, 'utf8'))?.dwarfId).toBe(LAUNCHED)
    const viewId = basename(path, '.token')
    expect(r.tokens.consume(viewId, token)).toBe(LAUNCHED)
  })

  it('[ADR-003] issuing a view removes the files of the tokens that expired unused', async () => {
    const r = real()
    const stale = (await r.resolver.targetFor(LAUNCHED)).credentialFile ?? ''
    r.clock.advance(VIEW_TOKEN_TTL_MS + 1)
    const fresh = (await r.resolver.targetFor(LAUNCHED)).credentialFile ?? ''

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})
