/**
 * Settings copy design has not delivered yet: marker keys, never shipped text (AGENTS.md §8.1, the
 * `⟦COPY NEEDED⟧` rule). Each one names its design item; the release docs check of EPIC-17 blocks
 * v1 while any is still drawn (TC-264-03).
 *
 * DG-22 (DR-06): the OpenCode permission-requests help paragraph. The design's paragraph
 * (DwarfAI-Miners-Design d12d3fc, prototype/organisms/settings/settings.js:195) says the plugin
 * file holds "the same token this app uses to trust Claude Code's instant updates". Under ADR-016
 * item 1 that is false: the Host's plugin writer bakes the plugin channel's own
 * `openCodePluginToken` and the Claude hook entry carries `claudeHookToken`
 * (host/modules/preferences/adapters/external-config/openCodePlugin/pluginArtifact.ts,
 * claudeHooks/hookCommand.ts), so the paragraph waits for design's rewrite (ADR-016 item 8).
 */
export const OPENCODE_PERMISSION_HELP =
  '⟦COPY NEEDED: DG-22 OpenCode permission-requests help paragraph⟧'
