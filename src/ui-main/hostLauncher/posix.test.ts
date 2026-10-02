// layer: L3
// The real POSIX spawner over a recording `spawn` (the child-process double plays the process: it starts, exits or
// cannot start), its working folder a per-test temporary folder; this OS's real spawn is the L8 leg
// (spawner.os.test.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { RecordingSpawnProcess, type FakeChildProcess } from './fakes/FakeChildProcess'
import { createPosixSpawner } from './posix'
import { runHostSpawnerContract } from './testing/hostSpawner.contract'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

runHostSpawnerContract('createPosixSpawner over a recording spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-posix-spawner-'))
  roots.push(root)
  const spawn = new RecordingSpawnProcess()
  let script: string = 'keeps-running'
  let last: FakeChildProcess | null = null
  spawn.onSpawn = (child) => {
    last = child
    if (script === 'cannot-start') {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      return
    }
    child.emit('spawn')
    if (script === 'exits-with-3') queueMicrotask(() => child.finish(3))
  }
  return Promise.resolve({
    spawner: createPosixSpawner({ spawnProcess: spawn.spawn }),
    request: (next) => {
      script = next
      return { file: `/opt/app/host-${next}`, args: [], env: {}, cwd: root }
    },
    afterLaunch: () => {},
    stillRunning: () => Promise.resolve(last !== null && last.exitCode === null && !last.killed)
  })
})
