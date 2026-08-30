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

Use GitHub's private vulnerability reporting on this repository:
[open a draft security advisory](https://github.com/JeronimoRepetto/DwarfAI-Miners/security/advisories/new)
(repository **Security** tab → **Report a vulnerability**). Please do not open a public issue
or pull request for anything exploitable — a public report is public before a fix exists.

A useful report includes the app version, your OS, reproduction steps, and what an attacker
gains. A proof of concept helps; a fix suggestion is welcome but not expected.

## What to expect

This is a solo-maintainer project, so the process is honest rather than corporate:
acknowledgment is best-effort (usually within a few days), confirmed vulnerabilities are
fixed in the next release, and there is no bug bounty. You will be credited in the advisory
and release notes unless you ask not to be.

## Scope

In scope — the app's own attack surface:

- **The loopback hooks listener** (`src/main/hooks/`): bypassing the per-install token,
  reaching the listener from off-box despite the `127.0.0.1` bind, or exceeding the 4 KB
  body cap's memory guarantees.
- **The Claude `settings.json` writer** (`src/main/hooks/hookInstaller.ts`): any path where
  install or uninstall corrupts the file or touches entries that are not DwarfAI-Miners' own.
- **The message relay** (`src/main/textDelivery/`): making the one-shot `claude -p` turn do
  anything beyond delivering the message to the named session.
- **The renderer/preload boundary** (`src/main/window.ts`, `src/preload/`): escaping the
  typed API or the deny-and-open-externally navigation rule.
- **Transcript redaction** (`src/main/domain/redactSecrets.ts`): a class of secrets that
  predictably escapes the redaction pass. Note that redaction is display hardening and
  deliberately lossy — it is not, and does not claim to be, a guarantee.

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

- The renderer runs with context isolation enabled and Node integration disabled, and the
  panel denies all external navigation, handing URLs to the system browser
  (`src/main/window.ts`). Electron's Chromium sandbox is currently disabled
  (`sandbox: false`), so the preload/context-isolation line is the boundary that matters.
- The hooks listener binds `127.0.0.1` only, drops unauthenticated requests before reading
  their body (constant-time token comparison), and caps bodies at 4 KB
  (`src/main/hooks/hookServer.ts`, `src/main/hooks/hookToken.ts`).
- The relay turn is restricted to the `ListAgents` and `SendMessage` tools and fences the
  message payload so its content cannot become instructions that execute commands
  (`src/main/textDelivery/relay.ts`).
- Transcript text is redacted at the provider boundary, before it ever crosses into the
  renderer (`src/main/providers/`, `src/main/domain/redactSecrets.ts`).
