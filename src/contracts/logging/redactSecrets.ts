/**
 * Redaction for transcript text the panel displays.
 *
 * Speech bubbles, tooltips and the feed modal render transcript text in an
 * always-on-top window — and from there into every screenshot and screen
 * share. The most common way a secret enters a transcript is the user pasting
 * one into their own session, so providers pass lastMessage and every feed
 * text through here BEFORE the strings ever cross into preload/renderer
 * territory. Order matters: the renderer truncates bubbles to 70 chars, and a
 * truncated prefix can still contain a whole key, so redaction must happen at
 * the provider boundary, never after truncation.
 *
 * The philosophy is deliberately lossy: a 40-char hex run is
 * indistinguishable from a git SHA, and the generic rule can eat an unusually
 * entropic identifier. Redacting a SHA costs the user a copy-paste; leaking a
 * key costs the key. False positives on display text are cheap, false
 * negatives are not — the transcript on disk is untouched either way.
 */

/** What every matched secret is replaced with. */
export const REDACTED = '[redacted]'

/**
 * Token shapes with an issuer-documented prefix, applied first so each secret
 * collapses into ONE marker before the broader hex/base64 nets see the text.
 *
 * - GitHub PATs: gh[pousr]_ + 36+ alphanumerics (classic and fine-grained).
 * - sk- keys (OpenAI/Anthropic style): sk- + 20+ of [A-Za-z0-9_-], which
 *   also covers prefixed forms like sk-proj- and sk-ant- in one match.
 * - Google API keys: AIza + 30+ of the documented alphabet.
 * - Slack tokens: xox[baprs]- + the dashed id/secret sections.
 * - JWTs: three dot-separated base64url segments, the first starting with
 *   eyJ ({"…) — matched whole so a JWT is one redaction, not three.
 */
const PREFIXED_SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
]

/**
 * A hex run of 40+ chars: SHA-1-sized and larger digests, session tokens,
 * webhook secrets. Yes, this catches git commit SHAs — that tradeoff is
 * accepted on purpose (see the module docstring). Short hashes (≤ 12 chars,
 * the usual abbreviated-SHA length) never reach the length floor.
 */
const HEX_RUN_PATTERN = /\b[0-9a-fA-F]{40,}\b/g

/**
 * Candidate for the generic net: a 40+ char run of base64/identifier-ish
 * characters plus up to two trailing padding '='. '=' is deliberately NOT in
 * the run body so `TOKEN=value` redacts only the value, and '/' is excluded
 * because it would swallow URLs and POSIX paths — which means a slash-carrying
 * base64 secret can escape this net. The prefixed patterns above are the
 * primary defense; this one only widens it where prose cannot be mangled.
 */
const GENERIC_RUN_PATTERN = /[A-Za-z0-9+_-]{40,}={0,2}/g

/**
 * Does a generic run look like key material rather than prose? Long camelCase
 * identifiers have no digits; ALL-CAPS constants have no lowercase; real
 * base64 key material virtually always mixes all three. Requiring the mix
 * keeps "thisIsAVeryLongIdentifier" intact while catching secrets.
 */
function looksLikeSecret(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && (run.match(/\d/g)?.length ?? 0) >= 2
}

export function redactSecrets(text: string): string
export function redactSecrets(text: string | undefined): string | undefined
export function redactSecrets(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return text
  let result = text
  for (const pattern of PREFIXED_SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED)
  }
  result = result.replace(HEX_RUN_PATTERN, REDACTED)
  return result.replace(GENERIC_RUN_PATTERN, (run) => (looksLikeSecret(run) ? REDACTED : run))
}
