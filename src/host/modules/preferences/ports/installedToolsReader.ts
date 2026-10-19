// Driven port (05 §3.12, 16 §4.12; AMENDMENT-10, OQ-78): which of Claude Code and OpenCode the
// suppliers installed detection found (ADR-009 D5), as integration ids (`claude-hooks` for Claude
// Code, `opencode-permissions` for OpenCode). The `host/wiring` bridge implements it
// (bridges/installedTools.ts), so preferences never imports suppliers (R4). It reads the
// detection's cache and never scans; it feeds `WelcomeStepState.offered` (AMENDMENT-9).
import type { IntegrationId } from '../../../kernel/domain/values'

// As 16 §4.12 writes it (names, members and comment; layout by prettier)
export interface InstalledToolsReader {
  installed(): IntegrationId[]
} // bridge (host/wiring) → suppliers installed detection (ADR-009 D5); feeds WelcomeStepState.offered (AMENDMENT-9) (AMENDMENT-10, OQ-78)
