// L8 OS lane (17 §1.8; ADR-002 D3; 07 S12.01; 13 FM-010): the spawn gate `<hostDataDir>/run/spawn.gate` between UI
// processes of this OS. Each launcher is a process of its own running the launcher's own gate code (SpawnGate over
// NodeGateFiles, its owner checked by this OS's start-time reader), bundled for the run. Two launchers released at
// the same instant race for the gate: exactly one takes it, the other finds it held. A launcher that dies holding the
// gate leaves it behind, and the next launcher takes it over once the real probe finds the owner gone. Every
// launcher is ended in `finally`, and the temporary folder is removed at the end. The rules themselves are proven at
// L1/L2 (spawnGate.test.ts) and the file operations at L3 (gateFiles.test.ts).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleEntry, NodeScript, repoImport } from './testing/osProcess'

const CASE_TIMEOUT_MS = 120_000
/** A cold Windows PowerShell start-time read takes a few seconds; the launchers read theirs before the start line. */
const READY_TIMEOUT_MS = 30_000
const ROUNDS = 3

/**
 * One launcher: reads its own identity, says `ready`, waits for the start file, takes the gate and prints the
 * answer. Holding it, it waits for its release file and releases (`never`: it holds until it is killed). A safety
 * timer ends it after a minute whatever happens.
 */
const LAUNCHER = `
import { existsSync } from 'node:fs'
import { SpawnGate } from ${repoImport('src', 'ui-main', 'hostLauncher', 'spawnGate.ts')}
import { NodeGateFiles } from ${repoImport('src', 'ui-main', 'hostLauncher', 'gateFiles.ts')}
import { createIdentityProbe, createProcessStartReader } from ${repoImport('src', 'ui-main', 'hostLauncher', 'processStart.ts')}
import { osQueryRunner, thisPlatform } from ${repoImport('src', 'ui-main', 'hostLauncher', 'testing', 'osQueryRunner.ts')}

setTimeout(() => process.exit(9), 60_000)
const [gatePath, startFile, releaseFile] = process.argv.slice(2)
const read = createProcessStartReader({ platform: thisPlatform(), runQuery: osQueryRunner() })
const own = await read(process.pid)
const self = {
  pid: process.pid,
  processStartTimeMs: own.kind === 'started' ? own.ms : Math.round(performance.timeOrigin)
}
const gate = new SpawnGate({
  files: new NodeGateFiles(gatePath),
  probe: createIdentityProbe(read),
  clock: { now: Date.now },
  self: () => Promise.resolve(self)
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
console.log('ready')
while (!existsSync(startFile)) await pause(1)
const answer = await gate.take()
console.log(answer)
if (answer === 'taken') {
  if (releaseFile === 'never') await new Promise(() => {})
  while (!existsSync(releaseFile)) await pause(10)
  await gate.release()
  console.log('released')
}
process.exit(0)
`

let root = ''
let script = ''
let file = 0

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'dwarfai-gate-os-'))
  script = await bundleEntry(LAUNCHER, path.join(root, 'bundle'), 'launcher')
}, CASE_TIMEOUT_MS)

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A fresh marker file path under the case folder. */
function marker(name: string): string {
  file += 1
  return path.join(root, `${name}-${file}`)
}

const answerOf = (line: string): boolean => line === 'taken' || line === 'held'

describe('the spawn gate between launcher processes (ADR-002 D3)', () => {
  it(
    '[ADR-002, S12.01, FM-010] of two launcher processes racing for the gate, exactly one takes it and the other finds it held',
    async () => {
      const gate = path.join(root, 'race', 'run', 'spawn.gate')
      const started: NodeScript[] = []
      try {
        for (let round = 1; round <= ROUNDS; round += 1) {
          const start = marker('start')
          const release = marker('release')
          const racers = [0, 1].map(() => new NodeScript(script, [gate, start, release]))
          started.push(...racers)
          for (const racer of racers) await racer.line((line) => line === 'ready', READY_TIMEOUT_MS)

          writeFileSync(start, '')
          const answers = await Promise.all(
            racers.map((racer) => racer.line(answerOf, READY_TIMEOUT_MS))
          )

          expect([...answers].sort(), `round ${round}`).toEqual(['held', 'taken'])
          const winner = racers[answers.indexOf('taken')] as NodeScript
          writeFileSync(release, '')
          await winner.line((line) => line === 'released', READY_TIMEOUT_MS)
          expect(existsSync(gate), `round ${round}: the gate is gone once released`).toBe(false)
          for (const racer of racers) expect(await racer.exited).toBe(0)
        }
      } finally {
        for (const launcher of started) await launcher.kill()
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    '[ADR-002, FM-010] a gate whose owner process died is taken over by the next launcher; while that one holds it, another finds it held',
    async () => {
      const gate = path.join(root, 'takeover', 'run', 'spawn.gate')
      const start = marker('start')
      writeFileSync(start, '')
      const started: NodeScript[] = []
      const launch = (release: string): NodeScript => {
        const launcher = new NodeScript(script, [gate, start, release])
        started.push(launcher)
        return launcher
      }
      try {
        const dying = launch('never')
        expect(await dying.line(answerOf, READY_TIMEOUT_MS)).toBe('taken')
        await dying.kill()
        expect(existsSync(gate), 'a killed owner leaves its gate behind').toBe(true)

        const release = marker('release')
        const next = launch(release)
        expect(await next.line(answerOf, READY_TIMEOUT_MS)).toBe('taken')
        const another = launch(marker('release'))
        expect(await another.line(answerOf, READY_TIMEOUT_MS)).toBe('held')

        writeFileSync(release, '')
        await next.line((line) => line === 'released', READY_TIMEOUT_MS)
        expect(existsSync(gate)).toBe(false)
      } finally {
        for (const launcher of started) await launcher.kill()
      }
    },
    CASE_TIMEOUT_MS
  )
})
