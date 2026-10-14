// The fixture transport (15 §6, 17 §1.4, §1.10): replays the bytes a provider wrote on fake stdio
// and records what the driver sends back, so a driver runs against a recorded session with no
// process, no network and no timer. JSONL is replayed line by line, each line held until the driver
// has sent as many frames as the recording shows before it (the timing stream, `gates`), as
// recorded, split in the middle or coalesced; recorded HTTP / SSE exchanges are answered in order.
// The two injectors of 17 §1.10: an early EOF (`eof()`, CH-04, C-18) and a provider that never
// answers again (`hang()`, CH-05, C-15).
import { PassThrough, Writable } from 'node:stream'
import type { Json } from './expected'

export type Chunking = 'as-recorded' | 'split' | 'coalesced'

export interface FixtureTransportOptions {
  /** What the provider wrote: JSONL text, or a JSON `{ exchanges }` record. */
  readonly received: string
  readonly format: 'jsonl' | 'json'
  /** Per JSONL line: how many driver frames must precede it; absent = all at once. */
  readonly gates?: readonly number[]
  /** What the provider wrote on stderr (delivered at once). */
  readonly stderr?: string
  readonly chunking?: Chunking
}

/** One recorded HTTP exchange; an SSE body is its list of event chunks. */
export interface RecordedExchange {
  readonly request: { readonly method: string; readonly path: string }
  readonly response: {
    readonly status: number
    readonly body?: Json
    readonly sse?: readonly string[]
  }
}

export class FixtureTransport {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** Every frame the driver sent, in order (a JSONL line, or an HTTP request). */
  readonly sent: string[] = []
  private readonly lines: string[]
  private readonly gates: readonly number[]
  private readonly exchanges: RecordedExchange[]
  private delivered = 0
  private pendingInput = ''
  private ended = false
  private started = false
  private hung = false
  private readonly endListeners: (() => void)[] = []

  constructor(private readonly options: FixtureTransportOptions) {
    this.lines = options.format === 'jsonl' ? splitLines(options.received) : []
    this.gates = options.gates ?? []
    this.exchanges =
      options.format === 'json'
        ? [
            ...(((JSON.parse(options.received || '{}') as { exchanges?: RecordedExchange[] })
              .exchanges ?? []) as RecordedExchange[])
          ]
        : []
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, done) => {
        this.receive(chunk.toString())
        done()
      }
    })
  }

  /** Starts the replay (the recording spawn calls it right after the spawn). */
  start(): void {
    if (this.started) return
    this.started = true
    if (this.options.stderr !== undefined && this.options.stderr !== '') {
      this.stderr.write(this.options.stderr)
    }
    this.pump()
  }

  /** CH-04 on demand: the provider's output ends now. */
  eof(): void {
    if (this.ended) return
    this.ended = true
    this.stdout.end()
    this.stderr.end()
    for (const listener of this.endListeners.splice(0)) listener()
  }

  /** CH-05 on demand: from now on the provider answers nothing (it hangs; it does not exit). */
  hang(): void {
    this.hung = true
  }

  /** Called once when the output ended (the recording spawn then ends the process). */
  onEnd(listener: () => void): void {
    if (this.ended) listener()
    else this.endListeners.push(listener)
  }

  /** The next recorded exchange for `method path`, recorded as sent; `null` when none is left. */
  request(method: string, path: string, body?: Json): RecordedExchange['response'] | null {
    this.sent.push(JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) }))
    if (this.hung) return null
    const index = this.exchanges.findIndex(
      (exchange) => exchange.request.method === method && exchange.request.path === path
    )
    if (index === -1) return null
    const [exchange] = this.exchanges.splice(index, 1)
    return exchange?.response ?? null
  }

  private receive(text: string): void {
    this.pendingInput += text
    let newline = this.pendingInput.indexOf('\n')
    while (newline !== -1) {
      const frame = this.pendingInput.slice(0, newline).replace(/\r$/, '')
      this.pendingInput = this.pendingInput.slice(newline + 1)
      if (frame !== '') this.sent.push(frame)
      newline = this.pendingInput.indexOf('\n')
    }
    this.pump()
  }

  /** Delivers every line whose gate is open, in the chosen chunking. */
  private pump(): void {
    if (!this.started || this.ended) return
    const ready: string[] = []
    while (this.delivered < this.lines.length && !this.hung) {
      if ((this.gates[this.delivered] ?? 0) > this.sent.length) break
      ready.push(this.lines[this.delivered] as string)
      this.delivered += 1
    }
    this.write(ready)
  }

  private write(lines: readonly string[]): void {
    if (lines.length === 0) return
    switch (this.options.chunking ?? 'as-recorded') {
      case 'coalesced':
        this.stdout.write(lines.join(''))
        break
      case 'split':
        for (const line of lines) {
          const middle = Math.max(1, Math.floor(line.length / 2))
          this.stdout.write(line.slice(0, middle))
          this.stdout.write(line.slice(middle))
        }
        break
      default:
        for (const line of lines) this.stdout.write(line)
    }
  }
}

/** The lines of a JSONL text, each with its own terminator (LF or CRLF); blank lines dropped. */
export function splitLines(text: string): string[] {
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter((line) => line.trim() !== '')
}

/**
 * Per JSONL line, how many driver frames the recording shows before it: the timing stream lists
 * every `received` and `sent` chunk in order with its byte count (`record.mjs` tee transport);
 * a line is gated by the `sent` chunks seen before the received chunk that completes it.
 */
export function gatesFromTiming(received: string, timing: string): number[] {
  const lines = splitLines(received.replaceAll('\r\n', '\n'))
  const ends: number[] = []
  let offset = 0
  for (const line of lines) {
    offset += Buffer.byteLength(line)
    ends.push(offset)
  }
  const gates: number[] = lines.map(() => 0)
  let sentSeen = 0
  let consumed = 0
  let next = 0
  for (const entry of splitLines(timing.replaceAll('\r\n', '\n'))) {
    const mark = JSON.parse(entry) as { stream?: string; bytes?: number }
    if (mark.stream === 'sent') sentSeen += 1
    if (mark.stream !== 'received') continue
    consumed += mark.bytes ?? 0
    while (next < lines.length && (ends[next] as number) <= consumed) gates[next++] = sentSeen
  }
  while (next < lines.length) gates[next++] = sentSeen
  return gates
}
