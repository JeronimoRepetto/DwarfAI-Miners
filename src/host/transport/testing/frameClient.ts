// A seam-B test client (17 §1.6): writes frames to a duplex end (in process or a real pipe/socket)
// and records everything it receives, decoded with the shared frame codec. Test-only (R14).
import type { Duplex } from 'node:stream'
import { encodeFrame, FrameDecoder } from '@dwarfai/contracts'

export class FrameClient {
  /** Every decoded frame, in arrival order. */
  readonly frames: unknown[] = []
  /** Every byte received, framed or not. */
  bytes = 0
  closed = false
  private readonly decoder = new FrameDecoder()

  constructor(readonly stream: Duplex) {
    // The client side accepts the larger cap: a test asserts what the Host sends, not the UI rule.
    this.decoder.helloOk()
    stream.on('data', (chunk: Uint8Array) => {
      this.bytes += chunk.length
      this.decoder.push(chunk)
      for (let next = this.decoder.next(); next !== null; next = this.decoder.next()) {
        this.frames.push(next.kind === 'frame' ? next.message : next)
      }
    })
    stream.on('error', () => {})
    stream.once('close', () => (this.closed = true))
  }

  send(message: unknown): void {
    this.stream.write(encodeFrame(message))
  }

  sendRaw(bytes: Uint8Array): void {
    this.stream.write(bytes)
  }

  /** Resolves once `condition` holds, polling every few ms; rejects after `ms`. */
  async until(condition: () => boolean, ms = 2_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('FrameClient.until: condition not met in time')
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }

  /** Lets every pending stream event run (in-process pairs deliver on the next ticks). */
  async settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
}
