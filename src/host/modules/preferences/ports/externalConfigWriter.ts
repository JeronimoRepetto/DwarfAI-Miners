// Driven port (05 §3.12, 16 §4.12, §7; ADR-016 item 6): the one writer of DwarfAI's entries in other
// tools' configuration files. Created by ISSUE-212 for the Reset saga's `external-config` step
// (lead decision 2026-09-30); its adapters (`ClaudeHooksConfigWriter`,
// `OpenCodePluginConfigWriter`) and its contract suite (16 §7.6) come with ISSUE-218…ISSUE-221,
// which keep this file. File I/O, never inside a transaction (16 §2.2).
import type { Result } from '../../../kernel/domain/values'

/** 05 §3.12 `ConsentOrigin`: the consent entry points (ADR-016 item 5). */
export type ConsentOrigin = 'settings' | 'add-panel' | 'first-run'

/**
 * A channel token as the writer installs it (ADR-016 item 1). Package gap: 05 and 16 name the type
 * without defining it; it is an opaque string here, and only its SHA-256 hash is ever stored
 * (`ChannelTokenStore`).
 */
export type ChannelToken = string & { readonly __brand: 'ChannelToken' }

// As 16 §4.12 writes them (names, members and comments; layout by prettier)
export type ConfigTarget = 'claude-hooks' | 'opencode-plugin'
export interface ExternalConfigWriter {
  // ADR-016 item 6 (the one config writer; name as in ADR-016, 07, 09); contract 16 §7
  install(
    target: ConfigTarget,
    token: ChannelToken,
    origin: ConsentOrigin
  ): Promise<
    Result<
      { verified: true; backupPath: string | null },
      'foreign-entry-conflict' | 'concurrent-modification' | 'io'
    >
  > // origin recorded in config_writes (claude-hooks: 'settings' | 'first-run'); an old-app entry of the target is replaced in the same write (AMENDMENT-7, OQ-68)
  verify(target: ConfigTarget): Promise<'verified' | 'absent' | 'mismatch'> // boot re-verification of an unverified write (07 S14.08, S14.11)
  revert(target: ConfigTarget): Promise<Result<void, 'locked' | 'io'>> // 07 S14.07: a locked file keeps the integration on; also removes an old-app entry of the target (AMENDMENT-7)
  findLegacy(target: ConfigTarget): Promise<boolean> // AMENDMENT-7 (OQ-68): an entry written by the old app (legacy probe, 16 §7.1) and no active config_writes row; Host boot (07 S41.02)
}
