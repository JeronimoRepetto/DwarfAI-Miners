// L6 (17 §1.6), in process: the owner-only pipe contract run against its double on this OS's real
// transport — a named pipe on Windows, a Unix socket in a temp directory elsewhere. The native
// helper runs the same contract in the Windows OS lane (nativeOwnerOnlyPipe.os.test.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { createFakeOwnerOnlyPipe } from './fakes/FakeOwnerOnlyPipe'
import { runOwnerOnlyPipeContract } from './windowsPipeSecurity.contract'

const WINDOWS = process.platform === 'win32'
// Directly under /tmp: a socket path must fit `sun_path` (104 bytes on macOS).
const root = WINDOWS ? '' : mkdtempSync('/tmp/dw022p-')
afterAll(() => {
  if (!WINDOWS) rmSync(root, { recursive: true, force: true })
})

let counter = 0

runOwnerOnlyPipeContract('FakeOwnerOnlyPipe (Node net.Server)', () => ({
  listen: createFakeOwnerOnlyPipe().listen,
  freshName: () => {
    counter += 1
    const suffix = `${process.pid}-${counter}-${Math.random().toString(16).slice(2, 10)}`
    return WINDOWS ? `\\\\.\\pipe\\dwarfai-test-022p-${suffix}` : join(root, `p${counter}.sock`)
  }
}))
