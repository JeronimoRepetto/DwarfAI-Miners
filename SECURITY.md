# Security policy

DwarfAI-Miners is a local desktop app that reads the session files other AI coding tools
write. Its data boundary — what is read, what is stored, what is transmitted — is documented
in [`docs/privacy.md`](docs/privacy.md); this file covers how to report a vulnerability and
what the project's own attack surface is.

## Supported versions

The project is pre-1.0. Only the
[latest release](https://github.com/JeronimoRepetto/DwarfAI-Miners/releases/latest) is
supported: fixes ship as a new release and are not backported to older versions.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Anything older | No        |

## Reporting a vulnerability

**Please do not open a public issue or pull request for anything exploitable** — a public
report is public before a fix exists.

The channel to reach for first is GitHub's private vulnerability reporting:
[open a draft security advisory](https://github.com/JeronimoRepetto/DwarfAI-Miners/security/advisories/new)
(repository **Security** tab → **Report a vulnerability**). GitHub offers that form only on
public repositories whose maintainer has switched the feature on, so open the link and check
that the form is actually there before you count on it.

If it is not, there is no private form to use, and the way through is to ask for one: open a
public issue saying only that you have a security report and would like a private channel. No
reproduction, no proof of concept, no affected file, no hint at the class of bug — an issue
with that much and no more discloses nothing an attacker can act on, and it gets a private
channel opened for the details.

A useful report includes the app version, your OS, reproduction steps, and what an attacker
gains. A proof of concept helps; a fix suggestion is welcome but not expected.

## What to expect

This is a solo-maintainer project, so the process is honest rather than corporate:
acknowledgment is best-effort (usually within a few days), confirmed vulnerabilities are
fixed in the next release, and there is no bug bounty. You will be credited in the advisory
and release notes unless you ask not to be.

## Scope

In scope — the app's own attack surface:

- **The Host's loopback ingress** (`src/host/transport/ingress/httpIngress.ts`, its tokens in
  `src/host/transport/auth/`): bypassing a channel's token, reaching the listener from off-box
  despite the `127.0.0.1` bind, or exceeding the 256 KiB body cap's memory guarantees.
- **The Claude `settings.json` writer**
  (`src/host/modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter.ts`):
  any path where install or uninstall corrupts the file or touches entries that are not
  DwarfAI-Miners' own.
- **The observed-session relay** (`src/host/modules/conversation/adapters/observed-send/`): making
  it write a message or a key anywhere but the terminal of the session it was addressed to.
- **The renderer/preload boundary** (`src/ui-main/window/adapters/secureWindowOptions.ts`,
  `navigationGuard.ts` beside it, `src/preload/`): escaping the typed API, or navigating the app's
  own frame away from its entry.
- **Redaction** (`src/contracts/logging/redactSecrets.ts`): a class of secrets that predictably
  escapes the redaction pass where it applies. Note that redaction is deliberately lossy — it is
  not, and does not claim to be, a guarantee.

Out of scope:

- Vulnerabilities in Claude Code, Codex, or any other tool whose files this app observes —
  report those to their vendors.
- The unsigned installers and the SmartScreen/Gatekeeper warnings they cause: known,
  deliberate for now, and documented in [`docs/signing.md`](docs/signing.md).
- Reports that reduce to "a process running as your user can read files your user can read"
  — the session files this app parses are readable by any such process already. Forging
  hook events, however, is exactly what the install token exists to stop, so that _is_ in
  scope.

## Current hardening

Verified in source, not aspirational:

- The renderer runs sandboxed (`sandbox: true`), with context isolation enabled and Node
  integration disabled, from the one window factory
  (`src/ui-main/window/adapters/secureWindowOptions.ts`). Every navigation or redirect away from
  the app's own entry is prevented, a webview is never attached, and a link asking for a new
  window is refused, its URL handed to the system browser only when the external-link allowlist
  admits it (`src/ui-main/window/adapters/navigationGuard.ts`).
- The Host's ingress binds `127.0.0.1` only, refuses any `Origin` header and any `Host`
  other than `127.0.0.1:<port>`, rate-limits each channel, drops unauthenticated requests before
  reading their body (constant-time comparison of token digests), and caps bodies at 256 KiB
  (`src/host/transport/ingress/httpIngress.ts`, `src/host/transport/auth/channelTokenCheck.ts`).
- An ask's text and an activity summary line are redacted before they leave the Host (the
  `redactSecrets` rule of `src/contracts/logging/`, bound into the asking and driver adapters by
  `src/host/main.ts`), and so is every diagnostics log line (ADR-026). The legacy pass over every
  transcript message (`src/main/domain/redactSecrets.ts`) left with the legacy tree in cut 5. See
  [what is shown on screen](docs/privacy.md#what-is-shown-on-screen).
