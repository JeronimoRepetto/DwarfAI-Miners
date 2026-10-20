// The negotiation sources every ACP driver shares (15 §2.1, §2.4, §4.10). The ACP TS SDK is an
// in-process library: it is in a build only after S-008-1 allows it (ADR-008 item 1), and without
// that record every ACP driver reports `launch: false` (15 §2.4 "ACP TS SDK (library)" row;
// TC-151-04). The protocol source is what `initialize` negotiated: how a session is resumed
// (`session/load` replays, `session/resume` does not; `session-setup.mdx:83-243`). Pure.
import type { NegotiatedCapabilities } from '../../../../domain/mergeCapabilities'

/** The S-008-1 record of the ACP TS SDK this build carries. */
export interface AcpLibraryRecord {
  /** spike S-008-1: a closed, GPL-compatible "bundle: yes" row for the pinned SDK. */
  readonly s0081: boolean
}

/**
 * spike S-008-1 (owner, 2026-10-16): `@agentclientprotocol/sdk` 1.6.0, Apache-2.0,
 * GPL-3.0-or-later compatible, **bundle: yes**, pinned exactly. `scripts/release/s008-records.mjs`
 * fails the release when the lockfile pins a version without such a row.
 */
export const ACP_SDK_RECORD: AcpLibraryRecord = Object.freeze({ s0081: true })

/** A driver's probe source: its 15 §3 row, with `launch` closed unless the SDK is allowed. */
export function acpProbeSource(
  row: NegotiatedCapabilities,
  record: AcpLibraryRecord
): NegotiatedCapabilities {
  return record.s0081 ? { ...row } : { ...row, launch: false }
}

/** What `initialize` answered that the protocol source reads. */
export interface InitializeAnswer {
  readonly agentCapabilities?: {
    readonly loadSession?: boolean
    readonly sessionCapabilities?: {
      readonly resume?: unknown
      readonly close?: unknown
    }
  }
}

/** The protocol source of one session (15 §2.1): the resume method `initialize` offered. */
export function protocolSource(init: InitializeAnswer): NegotiatedCapabilities {
  const agent = init.agentCapabilities
  const resumable = agent?.sessionCapabilities?.resume != null
  return { resume: agent?.loadSession === true ? 'load' : resumable ? 'resume' : 'none' }
}
