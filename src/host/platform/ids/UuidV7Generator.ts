// The production IdGenerator (16 §3; ADR-005 item 3: surrogate ids are UUIDv7). Layout per
// RFC 9562 §5.7 with the §6.2 method 1 counter: a 48-bit Unix millisecond timestamp, version 7,
// a 12-bit counter in `rand_a`, variant 10, then 62 random bits.
//
// Ids sort by creation order within one Host: inside one millisecond the counter increases; when
// it runs out, or when the clock steps back, the timestamp field moves one millisecond ahead of
// the last one used instead of going back (RFC 9562 §6.2 allows this). Each new millisecond
// seeds the counter at random with its top bit clear, leaving at least 2 048 ids of headroom.
import { randomFillSync } from 'node:crypto'
import type { Clock } from '../../kernel/ports/clock'
import type { IdGenerator } from '../../kernel/ports/idGenerator'

export interface UuidV7GeneratorDeps {
  clock: Clock
}

const COUNTER_MAX = 0xfff
const COUNTER_SEED_MASK = 0x7ff

export class UuidV7Generator implements IdGenerator {
  private readonly clock: Clock
  private lastMs = -1
  private counter = 0

  constructor(deps: UuidV7GeneratorDeps) {
    this.clock = deps.clock
  }

  uuidv7(): string {
    const random = randomFillSync(new Uint8Array(10))
    const now = Math.floor(this.clock.now())
    if (now > this.lastMs) {
      this.lastMs = now
      this.counter = seed(random)
    } else if (this.counter < COUNTER_MAX) {
      this.counter += 1
    } else {
      this.lastMs += 1
      this.counter = seed(random)
    }

    const bytes = new Uint8Array(16)
    let ms = this.lastMs
    for (let i = 5; i >= 0; i -= 1) {
      bytes[i] = ms % 256
      ms = Math.floor(ms / 256)
    }
    bytes[6] = 0x70 | (this.counter >> 8)
    bytes[7] = this.counter & 0xff
    bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f)
    bytes.set(random.subarray(3, 10), 9)
    return format(bytes)
  }
}

function seed(random: Uint8Array): number {
  return (((random[0] ?? 0) << 8) | (random[1] ?? 0)) & COUNTER_SEED_MASK
}

function format(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
