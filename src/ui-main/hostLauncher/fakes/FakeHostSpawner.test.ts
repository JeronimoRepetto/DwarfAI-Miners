import { runHostSpawnerContract } from '../testing/hostSpawner.contract'
import { FakeHostSpawner } from './FakeHostSpawner'

runHostSpawnerContract('FakeHostSpawner', () => {
  const fake = new FakeHostSpawner()
  let exitedByScript = false
  return Promise.resolve({
    spawner: fake.spawn,
    request: (script) => {
      fake.outcome = script === 'cannot-start' ? { kind: 'failed', errCode: 'ENOENT' } : 'launched'
      return { file: `host-${script}`, args: [], env: {}, cwd: '.' }
    },
    afterLaunch: (script) => {
      if (script === 'exits-with-3') {
        exitedByScript = true
        fake.exit(3)
      }
    },
    stillRunning: () => Promise.resolve(!exitedByScript)
  })
})
