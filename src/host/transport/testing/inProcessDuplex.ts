// The L6 seam-B harness (17 §1.6): two connected in-process duplex streams, a stand-in for a pipe or
// socket pair, so real frames travel between a test client and the real transport with no OS
// transport under them. Test-only (R14).
//
// - Bytes written on one end are read on the other in the chunks they were written in, so a test
//   controls splitting and coalescing exactly.
// - `end()` on one end ends the other end's readable side; `destroy()` on one end closes both, as
//   a socket's peer sees a reset connection.
import { Duplex } from 'node:stream'

export interface DuplexPair {
  /** The end the Host's transport takes. */
  host: Duplex
  /** The end the test client drives. */
  client: Duplex
}

export function inProcessDuplex(): DuplexPair {
  const ends: { host?: Duplex; client?: Duplex } = {}
  const make = (peer: () => Duplex | undefined): Duplex =>
    new Duplex({
      allowHalfOpen: false,
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        const other = peer()
        if (other !== undefined && !other.destroyed) other.push(Uint8Array.from(chunk))
        callback()
      },
      final(callback) {
        const other = peer()
        if (other !== undefined && !other.destroyed) other.push(null)
        callback()
      },
      destroy(error, callback) {
        const other = peer()
        if (other !== undefined && !other.destroyed) other.destroy()
        callback(error)
      }
    })
  ends.host = make(() => ends.client)
  ends.client = make(() => ends.host)
  return { host: ends.host, client: ends.client }
}
