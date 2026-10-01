// The contract every `ListenOwnerOnlyPipe` passes (17 §1.3: the double runs the same suite as the
// real adapter). The double (fakes/FakeOwnerOnlyPipe.ts) runs it in `pnpm test`; the native helper
// (host/platform/endpoint/win-pipe) runs it in the Windows OS lane, where its security half (who
// may open the pipe) is proven too.
//
// What it fixes is what the endpoint server relies on: each connected client arrives as a socket
// that carries bytes both ways, a name that already has an instance is refused as in use (the
// ADR-002 D3 mutex), a client leaving ends its socket, and after `close` nobody connects and the
// name is free again.
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PIPE_NAME_IN_USE,
  type ListenOwnerOnlyPipe,
  type OwnerOnlyPipeServer
} from './windowsPipeSecurity'

export interface OwnerOnlyPipeSubject {
  listen: ListenOwnerOnlyPipe
  /** A fresh, unused endpoint name for this OS (a pipe name, or a socket path for a double). */
  freshName(): string
}

/** How many clients connect at the same time in the concurrency case. */
const CONCURRENT_CLIENTS = 50

export function runOwnerOnlyPipeContract(subject: string, make: () => OwnerOnlyPipeSubject): void {
  describe(`ListenOwnerOnlyPipe contract: ${subject}`, () => {
    const cleanups: Array<() => Promise<void> | void> = []

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    })

    /** Listens on a fresh name; handed-over sockets are collected and destroyed after the test. */
    async function listening(
      pipe: OwnerOnlyPipeSubject,
      name = pipe.freshName()
    ): Promise<{
      name: string
      server: OwnerOnlyPipeServer
      accepted: Socket[]
      errors: string[]
    }> {
      const accepted: Socket[] = []
      const errors: string[] = []
      const outcome = await pipe.listen(name, {
        onConnection: (socket) => {
          socket.on('error', () => {})
          accepted.push(socket)
        },
        onError: (code) => errors.push(code)
      })
      if (!outcome.ok) throw new Error(`expected a listening pipe, got ${outcome.code}`)
      let closed = false
      const close = async (): Promise<void> => {
        if (closed) return
        closed = true
        for (const socket of accepted) socket.destroy()
        await outcome.server.close()
      }
      cleanups.push(close)
      return { name, server: { close }, accepted, errors }
    }

    function client(name: string): Promise<Socket> {
      return new Promise((resolve, reject) => {
        const socket = connect(name)
        socket.once('connect', () => {
          socket.removeAllListeners('error')
          socket.on('error', () => {})
          cleanups.push(() => void socket.destroy())
          resolve(socket)
        })
        socket.once('error', reject)
      })
    }

    function nextData(socket: Socket): Promise<string> {
      return new Promise((resolve) =>
        socket.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      )
    }

    async function until(condition: () => boolean, what: string): Promise<void> {
      for (let waited = 0; !condition(); waited += 10) {
        if (waited > 5_000) throw new Error(`timed out waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    it('[ADR-003] a connected client is handed over as a socket that carries bytes both ways', async () => {
      const pipe = make()
      const { name, accepted, errors } = await listening(pipe)

      const socket = await client(name)
      await until(() => accepted.length === 1, 'the handed-over socket')
      const served = accepted[0] as Socket
      const atHost = nextData(served)
      socket.write('from-client')
      expect(await atHost).toBe('from-client')
      const atClient = nextData(socket)
      served.write('from-host')
      expect(await atClient).toBe('from-host')
      expect(errors).toEqual([])
    })

    it('[ADR-002] a name that already has an instance is refused as in use', async () => {
      const pipe = make()
      const { name } = await listening(pipe)

      const second = await pipe.listen(name, { onConnection: () => {}, onError: () => {} })

      expect(second).toEqual({ ok: false, code: PIPE_NAME_IN_USE })
      // The first one still serves.
      await client(name)
    })

    it('[ADR-003] clients connecting at the same time are each handed over', async () => {
      const pipe = make()
      const { name, accepted, errors } = await listening(pipe)

      const clients = await Promise.all(
        Array.from({ length: CONCURRENT_CLIENTS }, () => client(name))
      )
      await until(() => accepted.length === CONCURRENT_CLIENTS, 'every handed-over socket')
      const replies = await Promise.all(
        clients.map((socket, index) => {
          const reply = nextData(socket)
          ;(accepted[index] as Socket).write('x')
          return reply
        })
      )

      expect(replies).toEqual(Array.from({ length: CONCURRENT_CLIENTS }, () => 'x'))
      expect(errors).toEqual([])
    })

    it('[ADR-003] a client that disconnects ends its handed-over socket', async () => {
      const pipe = make()
      const { name, accepted } = await listening(pipe)
      const socket = await client(name)
      await until(() => accepted.length === 1, 'the handed-over socket')
      const served = accepted[0] as Socket
      let ended = false
      served.once('close', () => (ended = true))
      served.resume()

      socket.destroy()

      await until(() => ended, 'the handed-over socket to close')
    })

    it('[ADR-002] after close no client connects and the name can be listened on again', async () => {
      const pipe = make()
      const first = await listening(pipe)
      await client(first.name)
      await until(() => first.accepted.length === 1, 'the handed-over socket')

      await first.server.close()

      await expect(client(first.name)).rejects.toMatchObject({ code: expect.any(String) })
      const again = await listening(pipe, first.name)
      await client(again.name)
      await until(() => again.accepted.length === 1, 'a socket from the second listen')
    })
  })
}
