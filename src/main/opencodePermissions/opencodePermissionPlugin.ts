/**
 * The OpenCode plugin this app will one day write into the user's GLOBAL
 * OpenCode plugin directory (`~/.config/opencode/plugin(s)/` — the writing
 * itself is #588 T6, unstarted; this file is only the artifact to be written).
 *
 * It runs standalone, loaded and transpiled by the user's own `opencode`
 * binary (docs/opencode-format.md Row 15: both `.js` and `.ts` load at global
 * scope with no build step of this app's own). That makes it a different
 * runtime from everything else under `src/main/`: no Electron, no Node
 * module resolution back into this repo, none of this app's own
 * `node_modules`. So unlike every sibling file here, this one imports
 * NOTHING beyond what the compiled `opencode` binary itself provides
 * (`fetch`, `AbortSignal`, `Set`) — not even `./permissionPushPayload`, whose
 * shaping this plugin deliberately does NOT duplicate. It forwards the raw
 * ingredients (the event, and its own `ctx.serverUrl`) verbatim; shaping them
 * into the app's push payload happens once, server-side, in
 * `buildOpenCodePermissionPush` beside this file — the one place that
 * already-tested logic needs to exist. `hookServer.ts`'s OpenCode route is
 * what receives this POST and runs `parseOpenCodePushBody` over its body.
 *
 * PUSH_URL and PUSH_TOKEN are placeholders. The installer that writes this
 * file (T6) substitutes the real listener address -- `http://127.0.0.1:<the
 * hooks port><OPENCODE_PUSH_ROUTE>` (`src/main/hooks/hookCommand.ts`,
 * `src/main/hooks/hookServer.ts`, #588 T3) -- and a per-machine token before
 * it ever reaches disk, mirroring how `buildHookCommand` bakes a port and a
 * token into the Claude hook command it installs rather than this app
 * trusting a fixed one. Until T6 exists, this file is syntactically complete
 * and loadable, and simply has nowhere real to POST to.
 *
 * The auth header is `x-dwarfai-token: <token>` -- HOOK_TOKEN_HEADER exactly
 * as `hookServer.ts` checks it via `tokensMatch` (`hookToken.ts`), not an
 * `Authorization: Bearer` scheme. This app has one token mechanism for both
 * channels (#588 T3): reusing it here, rather than inventing a second one,
 * is what lets the same listener serve both without a second auth code path.
 * The literal string is repeated rather than imported for the same
 * zero-import reason PUSH_URL and PUSH_TOKEN are hardcoded placeholders.
 *
 * Reusing it is a coupling, not only a simplification: T6 will write this
 * same per-install token in plaintext into `~/.config/opencode/plugin/`, so
 * any local process able to read that file can then forge `Stop` /
 * `SessionEnd` / `Notification` events on the Claude route too. The token is
 * already plaintext in `~/.claude/settings.json` under the same threat
 * model, so this widens the FILE surface carrying it, not the trust model
 * itself -- T6 should inherit that fact rather than rediscover it.
 *
 * Never throws into its host and never blocks a turn on the network: a
 * broken push is "this app never heard about it", not a broken OpenCode
 * session. The `fetch` below is deliberately NOT awaited by the event
 * handler — it fires, and whatever it settles to is swallowed.
 */

const PUSH_URL = '__DWARFAI_OPENCODE_PUSH_URL__'
const PUSH_TOKEN = '__DWARFAI_OPENCODE_PUSH_TOKEN__'

/**
 * The only two events worth a round trip to this app (docs/opencode-format.md
 * Rows 15/16). Everything else OpenCode's own `event` hook fires — and a
 * single turn fires dozens, `plugin.added`/`catalog.updated`/
 * `message.part.delta` among them — is dropped before it ever reaches the
 * network, so an idle plugin costs the local listener nothing.
 */
const PUSHED_EVENT_TYPES = new Set(['permission.asked', 'permission.replied'])

interface OpenCodePluginContext {
  /** A bound `URL` instance, not a string (docs/opencode-format.md Row 15). */
  serverUrl: URL
}

interface OpenCodePluginEvent {
  type: string
  properties?: unknown
}

function pushEvent(serverUrl: URL, event: OpenCodePluginEvent): void {
  if (!PUSHED_EVENT_TYPES.has(event.type)) return
  try {
    fetch(PUSH_URL, {
      method: 'POST',
      // 'x-dwarfai-token', not 'authorization': see the module comment on why
      // this must match the Claude channel's own scheme rather than inventing
      // a second one.
      headers: { 'content-type': 'application/json', 'x-dwarfai-token': PUSH_TOKEN },
      body: JSON.stringify({ event, serverUrl: serverUrl.href }),
      signal: AbortSignal.timeout(2000)
    }).catch(() => {
      // The local listener may not be running (the opt-in switch is off, or
      // this app is closed) — that is an ordinary, silent outcome, not a
      // plugin error. See the module comment on why nothing here may throw.
    })
  } catch {
    // A synchronous failure building the request (e.g. a global `fetch` this
    // build does not provide) must not reach OpenCode's own event dispatcher
    // either.
  }
}

/**
 * OpenCode's own plugin entry shape: an async function receiving `ctx`
 * (docs/opencode-format.md Row 15's measured key set) and returning a
 * `Hooks` object. `event` is the one hook this plugin subscribes to.
 */
export const DwarfAiOpenCodePermissionPlugin = async (ctx: OpenCodePluginContext) => {
  return {
    event: async ({ event }: { event: OpenCodePluginEvent }) => {
      pushEvent(ctx.serverUrl, event)
    }
  }
}
