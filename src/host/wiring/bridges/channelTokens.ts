// The channel-token lookup bridge (ADR-016 items 1–2; 16 §4.12 `ChannelTokenStore`, "the hook
// ingress reads `active`"; 05 §4 "the hook ingress accepts or rejects by the active channel
// token"): the transport's `ChannelTokenCheck` reads the stored hashes through it, never the
// preferences module's store itself (R4). It answers the one active row of a channel on every call
// (no cache), so a rotated-out or revoked token's hash is never returned; it holds `active` alone,
// so the ingress can authenticate a request but never issue, revoke or withdraw a token. The hook
// ingress is bound to it where it is wired (later: ISSUE-140, review R7V-02).
import type { ChannelTokenStore } from '../../modules/preferences'

export function ingressChannelTokens(
  store: Pick<ChannelTokenStore, 'active'>
): Pick<ChannelTokenStore, 'active'> {
  return { active: (channel) => store.active(channel) }
}
