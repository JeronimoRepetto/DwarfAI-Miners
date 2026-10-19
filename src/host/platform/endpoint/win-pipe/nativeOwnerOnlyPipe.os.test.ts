// L8 Windows (17 §1.8): the native owner-only pipe helper, built (`pnpm build:native`) and loaded in
// this process. It passes the same contract as its double, imports no VC++ runtime, and leaks no
// handle. Who may open its pipe (ADR-003 item 2, SP-05 turned into a test) is proven on the Host's
// real endpoint in src/host/transport/endpoint/server.os.test.ts.
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runOwnerOnlyPipeContract } from '../../../transport/endpoint/windowsPipeSecurity.contract'
import { createNativeOwnerOnlyPipe, WIN_PIPE_BINARY } from './nativeOwnerOnlyPipe'
import { createPipeAccessProbe, type PipeAccessProbe } from './testing/pipeAccessProbe'
import { readPeImports } from './testing/peImports'

const WINDOWS = process.platform === 'win32'
const PREBUILDS = fileURLToPath(new URL('../../../../../prebuilds', import.meta.url))
const BINARY = join(PREBUILDS, `win32-${process.arch}`, WIN_PIPE_BINARY)

const freshName = (): string => `\\\\.\\pipe\\dwarfai-test-022n-${randomBytes(8).toString('hex')}`

/** Windows system DLLs the helper may import; anything else (a VC++ runtime above all) fails. */
const SYSTEM_DLLS = ['advapi32.dll', 'kernel32.dll']
/** The C runtime DLLs of a `/MD` build: VC++ redistributable and the universal CRT forwarders. */
const VC_RUNTIME = /^(vcruntime\d+|msvcp\d+|msvcr\d+|ucrtbased?|api-ms-win-crt-.*)\.dll$/i

describe.runIf(WINDOWS)(
  'the native owner-only pipe helper (ADR-003 item 2), built and loaded',
  () => {
    runOwnerOnlyPipeContract('native helper (win_pipe.c)', () => ({
      listen: createNativeOwnerOnlyPipe({ prebuildsDir: PREBUILDS }),
      freshName
    }))

    it('[ADR-003] the built helper imports no VC++ runtime: only Windows system DLLs, and node.exe on first use', () => {
      const { machine, imports, delayImports } = readPeImports(BINARY)

      expect(imports.filter((dll) => VC_RUNTIME.test(dll))).toEqual([])
      expect(imports.map((dll) => dll.toLowerCase()).sort()).toEqual(SYSTEM_DLLS)
      expect(delayImports.map((dll) => dll.toLowerCase())).toEqual(['node.exe'])
      expect(machine).toBe(process.arch === 'arm64' ? 0xaa64 : 0x8664)
    })

    describe('handles', () => {
      let probe: PipeAccessProbe
      beforeAll(async () => {
        probe = await createPipeAccessProbe()
      }, 180_000)
      afterAll(() => probe?.dispose())

      it('[ADR-003] accepting and ending many connections leaks no handle', async () => {
        const name = freshName()
        let ended = 0
        const outcome = await createNativeOwnerOnlyPipe({ prebuildsDir: PREBUILDS })(name, {
          onConnection: (socket) => {
            socket.on('error', () => {})
            socket.once('close', () => (ended += 1))
            socket.resume()
          },
          onError: (code) => {
            throw new Error(`unexpected accept error ${code}`)
          }
        })
        if (!outcome.ok) throw new Error(`expected a listening pipe, got ${outcome.code}`)
        const cycle = async (count: number): Promise<void> => {
          const target = ended + count
          for (let index = 0; index < count; index += 1) {
            const socket = await new Promise<Socket>((resolve, reject) => {
              const client = connect(name)
              client.once('connect', () => resolve(client))
              client.once('error', reject)
            })
            socket.destroy()
          }
          for (let waited = 0; ended < target; waited += 10) {
            if (waited > 10_000) throw new Error(`only ${ended} of ${target} connections ended`)
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        try {
          // Warm-up: thread-pool threads and libuv's own handles exist before the count.
          await cycle(20)
          const before = await probe.handleCount(process.pid)

          await cycle(300)

          const after = await probe.handleCount(process.pid)
          // A leak per connection would add at least 300; the pool's threads may move by a few.
          expect(after - before).toBeLessThan(30)
        } finally {
          await outcome.server.close()
        }
      }, 120_000)
    })
  }
)
