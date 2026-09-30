// Length caps of the seam-B params that seam A relays unchanged (14 §1.2), so every schema refuses an
// oversized string (14 §6.5 "Schemas"; ADR-019 Verification "Fuzz").
import { z } from 'zod'

/** 06 `MessageText`: UTF-8, at most 64 KiB (14 §3.4 `SendMessageParams.text`). */
export const MESSAGE_TEXT_MAX_BYTES = 64 * 1024

/**
 * Package gap (14 is silent): a provider id, model, effort or permission-mode value. Catalog ids and
 * provider tokens are short; 256 characters is far above any of them.
 */
export const WIRE_TOKEN_MAX_CHARS = 256

/**
 * Package gap (14 is silent): a file path or a command line. 32 767 characters is the longest
 * Windows path and command line (CreateProcess); POSIX paths are shorter.
 */
export const WIRE_PATH_MAX_CHARS = 32_767

/** UTF-8 byte length of a string, without relying on a host `TextEncoder`. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

export const messageTextSchema = z
  .string()
  .max(MESSAGE_TEXT_MAX_BYTES) // a cheap first bound: a UTF-16 unit is at least one UTF-8 byte
  .refine((text) => utf8ByteLength(text) <= MESSAGE_TEXT_MAX_BYTES, {
    message: `at most ${MESSAGE_TEXT_MAX_BYTES} UTF-8 bytes`
  })

export const wireTokenSchema = z.string().max(WIRE_TOKEN_MAX_CHARS)

export const wirePathSchema = z.string().max(WIRE_PATH_MAX_CHARS)
