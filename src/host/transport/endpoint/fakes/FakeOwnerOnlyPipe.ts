// The double of `ListenOwnerOnlyPipe` (17 §1.3, 16 §2.8 naming): Node's own `net.Server` on the
// given name, so the endpoint server's tests run on every OS without the native helper. It keeps
// the hand-off behaviour of the contract (windowsPipeSecurity.contract.ts) and none of the
// security: on Windows its pipe has Node's default DACL. Tests only; production never imports it
// (R14).
import { createServer, type Server } from 'node:net'
import {
  PIPE_NAME_IN_USE,
  type ListenOwnerOnlyPipe,
  type OwnerOnlyPipeListen
} from '../windowsPipeSecurity'

export interface FakeOwnerOnlyPipe {
  listen: ListenOwnerOnlyPipe
  /** The names listened on, in order, including refused ones. */
  readonly names: readonly string[]
}

export function createFakeOwnerOnlyPipe(): FakeOwnerOnlyPipe {
  const names: string[] = []
  const listen: ListenOwnerOnlyPipe = (name, handlers) => {
    names.push(name)
    const server: Server = createServer((socket) => handlers.onConnection(socket))
    return new Promise<OwnerOnlyPipeListen>((resolve) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        resolve({
          ok: false,
          code: error.code === 'EADDRINUSE' ? PIPE_NAME_IN_USE : (error.code ?? 'unknown')
        })
      )
      server.listen(name, () => {
        server.removeAllListeners('error')
        server.on('error', (error: NodeJS.ErrnoException) =>
          handlers.onError(error.code ?? 'unknown')
        )
        resolve({
          ok: true,
          server: { close: () => new Promise<void>((done) => server.close(() => done())) }
        })
      })
    })
  }
  return { listen, names }
}
