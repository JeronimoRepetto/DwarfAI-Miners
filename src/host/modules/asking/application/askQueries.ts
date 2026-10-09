// The `AskQueries` driving port (05 §3.7; 16 §4.7): the open asks for `session.snapshot` and for
// the frame projections (ADR-010 items 6, 9; 14 §4.1 `asks`). Read-only: no transaction, no event.
//
// Package gap (resolved in ISSUE-130): 05 and 16 name `AskView` without defining it. The only
// shape the contract ever sends for an ask is ADR-010's `AskRecord` (14 §3.5 `ask.opened`, §3.7
// the `asks` chunk), and `AskRecord` already is the text needed to redraw the card with its
// `currentStep` and never a partial pick (INV-75), so `AskView` is `AskRecord`.
import type { DwarfId } from '../../../kernel/domain/values'
import type { AskRecord } from '../domain/ask'

/** 05 §3.7 `AskView`: an ask as the transport sends it (package gap above). */
export type AskView = AskRecord

// verbatim: 05-modules-and-ports.md L897 (16 §4.7; `prettier-ignore` keeps it on one line)
// prettier-ignore
export interface AskQueries { openAsks(): AskView[]; openAskOf(dwarfId: DwarfId): AskView | null }
// end verbatim
