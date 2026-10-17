// Seam-B params and results of `conversation.*` that host-placed seam A rows relay unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import {
  dwarfIdSchema,
  feedPageRequestSchema,
  messageIdSchema,
  type DwarfId,
  type FeedPageRequest,
  type MessageId
} from '../../wire'
import { outcomeSchema, type Outcome } from '../errors'
import { requestIdSchema } from '../requestId'
import { messageTextSchema, wirePathSchema } from './bounds'

/** 05 `AttachmentPath` (14 §3 imports it; 05 gives no definition): a picker or drop path, re-validated by the Host. */
export type AttachmentPath = string

/**
 * 05 `AttachmentPick` (14 §3 imports it; 05 gives no shape): 14 §8 I-10 fixes it to today's
 * `DwarfAttachmentPick` field names, so A-25 keeps its shape (`[]` + a per-item `refusal`). The Host
 * describes a file without reading it (16 §4.6), so it never sets `thumbnail`, and of the refusals
 * it answers only `directory` (not a regular file), `unreadable` and `file-too-large` (over
 * 300 000 000 bytes, AMENDMENT-1); the others are the composer's own (ISSUE-169).
 */
export interface AttachmentPick {
  path: AttachmentPath
  attachment?: { path: AttachmentPath; name: string; kind: 'image' | 'file'; bytes: number }
  refusal?:
    | 'directory'
    | 'unreadable'
    | 'already-attached'
    | 'too-many'
    | 'file-too-large'
    | 'total-too-large'
  thumbnail?: string
}

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): conversation
export interface SendMessageParams {
  dwarfId: DwarfId
  text: string // ≤ 64 KiB (06 MessageText)
  attachments: AttachmentPath[] // picker or drop paths; re-validated by the Host
  requestId: string
}
export type SendMessageResult = Outcome<
  { messageId: MessageId },
  'cannot-receive' | 'attachment-refused'
>
export interface FeedParams {
  dwarfId: DwarfId
  page?: FeedPageRequest
}

export const attachmentPathSchema = wirePathSchema

/** B-M24 `conversation.send` params; A-23's request is this same object (14 §1.2). */
export const sendMessageParamsSchema = z
  .object({
    dwarfId: dwarfIdSchema,
    text: messageTextSchema,
    attachments: z.array(attachmentPathSchema),
    requestId: requestIdSchema
  })
  .strict()

export const sendMessageResultSchema = outcomeSchema(
  z.object({ messageId: messageIdSchema }).strict(),
  z.enum(['cannot-receive', 'attachment-refused'])
)

/** B-M28 `conversation.describeAttachments` params (14 §3.4): the paths to re-validate; no count limit. */
export const describeAttachmentsParamsSchema = z
  .object({ paths: z.array(attachmentPathSchema) })
  .strict()

/** B-M28 result item: one `AttachmentPick` per path, in the order asked. */
export const attachmentPickSchema = z
  .object({
    path: attachmentPathSchema,
    attachment: z
      .object({
        path: attachmentPathSchema,
        name: wirePathSchema,
        kind: z.enum(['image', 'file']),
        bytes: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    refusal: z
      .enum([
        'directory',
        'unreadable',
        'already-attached',
        'too-many',
        'file-too-large',
        'total-too-large'
      ])
      .optional(),
    thumbnail: z.string().optional()
  })
  .strict()

/** B-M26 `conversation.feed` params; A-15's request is this same object (14 §1.2). */
export const feedParamsSchema = z
  .object({ dwarfId: dwarfIdSchema, page: feedPageRequestSchema.optional() })
  .strict()

/** ADR-021 item 1 `TurnEndKind` (14 §3 imports it from ADR-021): how a turn ended. */
export type TurnEndKind = 'concluded' | 'capped' | 'errored' | 'interrupted'

/** B-F14 `turn.ended` `kind` (14 §3.5): exactly the four ADR-021 kinds; an unknown kind is refused. */
export const turnEndKindSchema = z.enum(['concluded', 'capped', 'errored', 'interrupted'])

/**
 * ADR-009 D2 `ProviderCapabilities['console']`, the one capability field ADR-031's `ConsoleTarget` names (owned by
 * ADR-009; the contracts package holds no `ProviderCapabilities`, so only this field is stated, as `ConsoleOpenResult`
 * does in ../../ipc/windowApi.ts).
 */
interface ProviderCapabilities {
  console: 'focus-terminal' | 'attach' | 'log'
}

// verbatim: ADR-031 item 1 (list indentation removed; prettier-ignore keeps the aligned comments). B-M29's result.
// prettier-ignore
export interface ConsoleTarget {
  mode: ProviderCapabilities['console']                  // ADR-009 D2
  // resolved by the Host; executed by the UI (foreground rules)
  focus?: { pid: number; startTime: number }             // focus-terminal
  command?: { program: string; args: readonly string[]; cwd: string } // attach / log, no shell (ADR-029 #8)
  credentialFile?: string                                // log: viewer-token file path (ADR-003 item 12); never the token itself
}
// end verbatim

/**
 * B-M29 `conversation.resolveConsole` result (14 §2.3; ADR-031 item 1): strict, so a field ADR-031 does not name (an
 * `env`, a token) is refused at the seam. A pid is a positive integer; a start time a finite number (ADR-014 item 1).
 */
export const consoleTargetSchema = z
  .object({
    mode: z.enum(['focus-terminal', 'attach', 'log']),
    focus: z
      .object({ pid: z.number().int().positive(), startTime: z.number().finite() })
      .strict()
      .optional(),
    command: z
      .object({ program: wirePathSchema, args: z.array(wirePathSchema), cwd: wirePathSchema })
      .strict()
      .optional(),
    credentialFile: wirePathSchema.optional()
  })
  .strict()

/** B-M29 `conversation.resolveConsole` params: the dwarf whose console the person opens. */
export const resolveConsoleParamsSchema = z.object({ dwarfId: dwarfIdSchema }).strict()
