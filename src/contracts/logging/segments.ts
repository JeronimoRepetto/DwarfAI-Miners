/**
 * Segment file names (ADR-026 item 1, 19 §2): `<prefix><seq>.jsonl`, `seq` zero-padded to six digits
 * and monotonic per prefix; a writer continues after the highest number its prefix already has.
 */
export type SegmentPrefix = 'host-' | 'ui-' | 'shim-'

const SEQ_DIGITS = 6
const MAX_SEQ = 10 ** SEQ_DIGITS - 1
const SEGMENT_NAME = /^(host-|ui-|shim-)(\d{6})\.jsonl$/

/** `segmentName('host-', 42)` → `host-000042.jsonl`. `seq` is 1…999 999; outside it is a defect. */
export function segmentName(prefix: SegmentPrefix, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) {
    throw new RangeError(`segment seq out of range: ${seq}`)
  }
  return `${prefix}${String(seq).padStart(SEQ_DIGITS, '0')}.jsonl`
}

/** The prefix and seq of a segment name, or `null` for any other file. */
export function parseSegmentName(name: string): { prefix: SegmentPrefix; seq: number } | null {
  const match = SEGMENT_NAME.exec(name)
  if (!match) return null
  return { prefix: match[1] as SegmentPrefix, seq: Number(match[2]) }
}

/** The seq a writer of `prefix` opens next: one after the highest existing one, or 1. */
export function nextSeq(existingNames: readonly string[], prefix: SegmentPrefix): number {
  let highest = 0
  for (const name of existingNames) {
    const parsed = parseSegmentName(name)
    if (parsed?.prefix === prefix && parsed.seq > highest) highest = parsed.seq
  }
  return highest + 1
}
