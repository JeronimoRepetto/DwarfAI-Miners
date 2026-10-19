// The captured stdout / stderr of an "Other…" command as entries for its `log` console (15 §4.11,
// ADR-031 items 1–2): a raw program speaks no protocol, so each line it writes is one entry,
// stdout lines as the dwarf's `message`s and stderr lines as `activity` steps (the log view's
// "one line per step"). Each entry is keyed by the byte offset where its line starts in its
// stream, so a replay of the same bytes yields the same `sourceKey`s however the pipe chunked them
// (15 §1.5, C-19). Offsets count the stream with every CRLF read as LF, so a Windows program's
// CRLF output keys exactly like the same lines ending in LF (HO-37). Bounded: an entry never holds
// more than `MAX_ENTRY_BYTES` of UTF-8 (06 MessageText); a longer line is cut into several
// entries, each keyed by its own offset, so no unterminated line grows without bound.
import { StringDecoder } from 'node:string_decoder'
import type { DriverEvent } from '../../../ports/providerDriver'
import { HOSTED_COMMAND_ADAPTER_ID } from './profile'

export type OutputStream = 'stdout' | 'stderr'

/** 06 `MessageText`: UTF-8, at most 64 KiB. */
export const MAX_ENTRY_BYTES = 64 * 1024

/** One captured line (or one bounded piece of a longer one) and where it starts in its stream. */
export interface OutputLine {
  readonly stream: OutputStream
  readonly offset: number
  readonly text: string
}

/** Reassembles one stream's chunks into lines keyed by byte offset. */
export class OutputTail {
  private readonly decoder = new StringDecoder('utf8')
  /** The unterminated line, already CRLF-normalized. */
  private pending = ''
  /** Where `pending` starts in the normalized stream. */
  private pendingOffset = 0
  /** A chunk ended in CR: the next chunk may start with its LF. */
  private carriageReturn = false

  constructor(readonly stream: OutputStream) {}

  /** The complete lines (and bounded pieces) this chunk finishes. */
  push(chunk: Buffer | string): OutputLine[] {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let text = (this.carriageReturn ? '\r' : '') + decoded
    this.carriageReturn = text.endsWith('\r')
    if (this.carriageReturn) text = text.slice(0, -1)
    this.pending += text.replaceAll('\r\n', '\n')
    const out: OutputLine[] = []
    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      out.push(...this.take(this.pending.slice(0, newline)))
      this.pendingOffset += 1
      this.pending = this.pending.slice(newline + 1)
      newline = this.pending.indexOf('\n')
    }
    while (Buffer.byteLength(this.pending, 'utf8') > MAX_ENTRY_BYTES) {
      const head = headWithin(this.pending, MAX_ENTRY_BYTES)
      out.push(...this.take(head))
      this.pending = this.pending.slice(head.length)
    }
    return out
  }

  /** The unterminated rest, as an entry (the stream ended, or the turn's output went quiet). */
  flush(): OutputLine[] {
    const rest = this.decoder.end() + (this.carriageReturn ? '\r' : '')
    this.carriageReturn = false
    this.pending += rest
    const text = this.pending
    this.pending = ''
    return this.take(text)
  }

  /** Emits `text` (no line terminator) at the pending offset, in bounded pieces, and moves past it. */
  private take(text: string): OutputLine[] {
    const out: OutputLine[] = []
    let rest = text
    while (rest !== '') {
      const piece = headWithin(rest, MAX_ENTRY_BYTES)
      // Blank lines carry nothing to show, but they still occupy their bytes of the stream.
      if (piece.trim() !== '') {
        out.push({ stream: this.stream, offset: this.pendingOffset, text: piece })
      }
      this.pendingOffset += Buffer.byteLength(piece, 'utf8')
      rest = rest.slice(piece.length)
    }
    return out
  }
}

/** The longest prefix of `text` whose UTF-8 fits in `max` bytes, never cutting a character. */
function headWithin(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= max) return text
  let end = max
  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** Where an entry belongs: its session's stream id (15 §1.5), the open turn and the instant. */
export interface EntryContext {
  /** `<providerId>:<providerSessionId>`. */
  readonly streamId: string
  readonly turnKey: string | null
  readonly at: number
  /** The one redaction rule (`contracts/logging` `redactSecrets`), bound by wiring (05 R9). */
  readonly redact: (text: string) => string
}

/** The `sourceKey` of the fact at `offset` of `stream` (15 §1.5 `<adapterId>:<streamId>:<eventId>`). */
export function entryKey(streamId: string, stream: OutputStream | 'stdin', offset: number): string {
  return `${HOSTED_COMMAND_ADAPTER_ID}:${streamId}:${stream}@${offset}`
}

/** One captured line as its log entry: stdout → the dwarf's message, stderr → an activity step. */
export function logEntry(line: OutputLine, context: EntryContext): DriverEvent {
  const sourceKey = entryKey(context.streamId, line.stream, line.offset)
  if (line.stream === 'stdout') {
    return {
      t: 'message',
      record: { sourceKey, role: 'dwarf', text: line.text, providerTime: null }
    }
  }
  return {
    t: 'activity',
    step: {
      sourceKey,
      turnKey: context.turnKey,
      kind: 'other',
      // 15 §1.2 ActivityStep.summary: one line, through redactSecrets (bound by wiring).
      summary: context.redact(line.text),
      state: 'finished',
      at: context.at
    }
  }
}
