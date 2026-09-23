import type { DwarfProvider } from '../../domain/types'

/**
 * What Jev is allowed to know about a provider's OWN tooling (#625) — the
 * tool names and instruction files a real prompt can name, so `provider`
 * criteria (`providerChoiceCriteria`, routeRequest.ts) has something to
 * connect them to besides held-vs-detached session style. Before this table,
 * a prompt naming Codex's own `request_user_input` tool ("call the
 * `request_user_input` tool ONCE with three questions…") had nothing here to
 * read against, and Jev routed it to Claude at 0.68 confidence instead —
 * issue #625's own reported root cause, from a live `JEV_DEBUG` trace.
 *
 * Same evidence rule this table's model-level sibling
 * (`modelCapability.ts`'s `ModelCapabilityEntry`) already holds every model
 * id to: every name traces to the provider's own official documentation or
 * its own open-source repository, never a third-party summary. A name this
 * app could not verify against a primary source is left out, with the
 * reason recorded in this file's own comments — never invented to fill a
 * gap (`jev-capabilities` skill's evidence rule, extended here from models to
 * providers).
 */
export interface ProviderToolingMarkers {
  /**
   * Tool names this CLI's own model-facing tool schema actually defines,
   * verified against a primary source. May include a name another
   * provider's own table also carries (`apply_patch` is real for both Codex
   * and OpenCode) — never filtered here, since filtering would hide the
   * fact rather than just avoid claiming it exclusive. `distinctiveToolingNames`
   * in routeRequest.ts is what keeps a shared name from being PRESENTED as
   * exclusive when it is rendered into a criterion.
   */
  toolNames: readonly string[]
  /**
   * Instruction/config file names this CLI reads for project context,
   * verified against a primary source — same shared-name caveat as
   * `toolNames` (`AGENTS.md` is real for more than one provider here).
   */
  instructionFiles: readonly string[]
  /**
   * Official documentation URLs, or a GitHub source-file URL for a fact read
   * off the provider's own open-source repository — never a third-party
   * summary, matching `ModelCapabilityEntry.sources`' own rule.
   */
  sources: readonly string[]
  /** The date this entry's facts were last checked against its sources. */
  verifiedOn: string
}

const VERIFIED_ON = '2026-09-23'

/* --- Claude Code ---------------------------------------------------------- */

const CLAUDE_TOOLS_REFERENCE = 'https://code.claude.com/docs/en/tools-reference'
const CLAUDE_MEMORY_DOCS = 'https://code.claude.com/docs/en/memory'

/**
 * `AskUserQuestion` and `Agent` (the subagent-launch tool; Claude Code's own
 * docs used to call this `Task`, and the tools-reference page above now
 * lists it as `Agent` — both names have been observed in this app's own
 * environment, `Agent` is the one this table cites since it is what the
 * currently-live docs name) are both listed, by exactly that name, in Claude
 * Code's own tools-reference page. `CLAUDE.md` is Claude Code's own memory
 * file (`code.claude.com/docs/en/memory`); that same page states Claude Code
 * "can also read a repository's AGENTS.md files … on their own or alongside
 * CLAUDE.md" — recorded here too, honestly, since Codex's and OpenCode's own
 * tables below carry it as well (see `distinctiveToolingNames`,
 * routeRequest.ts, for how a shared name like this one is kept from being
 * presented as exclusive to any one provider).
 */
export const CLAUDE_TOOLING_MARKERS: ProviderToolingMarkers = {
  toolNames: ['AskUserQuestion', 'Agent'],
  instructionFiles: ['CLAUDE.md', 'AGENTS.md'],
  sources: [CLAUDE_TOOLS_REFERENCE, CLAUDE_MEMORY_DOCS],
  verifiedOn: VERIFIED_ON
}

/* --- Codex CLI -------------------------------------------------------------- */

const CODEX_REQUEST_USER_INPUT_SOURCE =
  'https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs'
const CODEX_UPDATE_PLAN_SOURCE =
  'https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan_spec.rs'
const CODEX_APPLY_PATCH_SOURCE =
  'https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch_spec.rs'
const CODEX_AGENTS_MD_DOCS = 'https://developers.openai.com/codex/guides/agents-md'

/**
 * Issue #625's own reported case: `request_user_input` is a `pub const`
 * (`REQUEST_USER_INPUT_TOOL_NAME: &str = "request_user_input"`) in
 * `codex-rs`'s own open-source handler for that exact tool. `update_plan`
 * and `apply_patch` are the literal `name: "…".to_string()` values their own
 * sibling handler files build their `ToolSpec` with, read the same way —
 * `codex-rs` is Codex CLI's own published implementation, so its source is a
 * primary source, the same standing this table already gives Codex's model
 * cache in `codex.ts`. `apply_patch` is ALSO defined in OpenCode's own
 * `apply_patch.ts` (see `OPENCODE_TOOLING_MARKERS` below) — recorded here
 * anyway, since it is a true fact about Codex, never presented as exclusive
 * to it (`distinctiveToolingNames`, routeRequest.ts). `AGENTS.md` is Codex's
 * own documented instruction file, read "before doing any work" per OpenAI's
 * own docs (the URL above redirected to `learn.chatgpt.com` when fetched —
 * still OpenAI's own domain, not a third party) — also read by Claude Code
 * and OpenCode, per their own docs.
 */
export const CODEX_TOOLING_MARKERS: ProviderToolingMarkers = {
  toolNames: ['request_user_input', 'update_plan', 'apply_patch'],
  instructionFiles: ['AGENTS.md'],
  sources: [
    CODEX_REQUEST_USER_INPUT_SOURCE,
    CODEX_UPDATE_PLAN_SOURCE,
    CODEX_APPLY_PATCH_SOURCE,
    CODEX_AGENTS_MD_DOCS
  ],
  verifiedOn: VERIFIED_ON
}

/* --- OpenCode ---------------------------------------------------------------- */

const OPENCODE_QUESTION_TOOL_SOURCE =
  'https://github.com/sst/opencode/blob/main/packages/opencode/src/tool/question.ts'
const OPENCODE_APPLY_PATCH_SOURCE =
  'https://github.com/sst/opencode/blob/main/packages/opencode/src/tool/apply_patch.ts'
const OPENCODE_TOOLS_DOCS = 'https://opencode.ai/docs/tools/'
const OPENCODE_INTRO_DOCS = 'https://opencode.ai/docs/'

/**
 * `question` is OpenCode's own ask-the-user tool, registered by that exact
 * literal name (`Tool.define<...>("question", …)`) in its own open-source
 * `packages/opencode/src/tool/question.ts` — OpenCode's own distinctive
 * counterpart to Codex's `request_user_input` and Claude Code's own
 * `AskUserQuestion`. `apply_patch.ts` sits in the same source directory
 * (`ApplyPatchTool`, wired into the same tool registry), so `apply_patch` is
 * recorded for OpenCode too — honestly shared with Codex rather than claimed
 * unique to either (`distinctiveToolingNames`, routeRequest.ts). `AGENTS.md`
 * is documented on `opencode.ai/docs/` as the file its own `init` flow
 * writes to the project root — also read by Claude Code and Codex, per their
 * own docs.
 */
export const OPENCODE_TOOLING_MARKERS: ProviderToolingMarkers = {
  toolNames: ['question', 'apply_patch'],
  instructionFiles: ['AGENTS.md'],
  sources: [
    OPENCODE_QUESTION_TOOL_SOURCE,
    OPENCODE_APPLY_PATCH_SOURCE,
    OPENCODE_TOOLS_DOCS,
    OPENCODE_INTRO_DOCS
  ],
  verifiedOn: VERIFIED_ON
}

/* --- Antigravity: deliberately no entry ------------------------------------- */

/**
 * Every provider this table has EVIDENCE for, keyed the same way
 * `MODEL_CAPABILITIES` is (`modelCapability.ts`) — a `Partial` record, unlike
 * that one, because Antigravity has no entry AT ALL rather than an empty
 * one: its own docs (`antigravity.google/docs/cli/*`, checked 2026-09-23)
 * publish slash-COMMANDS (`/open`, `/btw`, …) and a `settings.json` shape,
 * never the literal tool-call names its model is actually given — no page
 * equivalent to Claude Code's own tools-reference table, or to Codex's and
 * OpenCode's own open-source tool registries, was found for `agy`. The CLI
 * itself is not installed on the machine this table was verified from
 * either (the same gap `antigravity.ts`'s own top comment already names for
 * model ids), so there is no `agy --help` this app could read instead.
 *
 * `PROVIDER_TOOLING_MARKERS.antigravity` therefore reads `undefined` —
 * `describeToolingMarkers` (routeRequest.ts) treats that the same
 * degrade-rather-than-invent way `lookupModelCapability` already treats an
 * unknown model id: the held/detached session sentence still names the
 * provider without it. Whoever can run a real `agy` session and read its own
 * tool-call trace should add an entry here and update this comment, the same
 * way `antigravity.ts` asks for its own model-id gap to be closed.
 */
export const PROVIDER_TOOLING_MARKERS: Readonly<
  Partial<Record<DwarfProvider, ProviderToolingMarkers>>
> = {
  claude: CLAUDE_TOOLING_MARKERS,
  codex: CODEX_TOOLING_MARKERS,
  opencode: OPENCODE_TOOLING_MARKERS
}
