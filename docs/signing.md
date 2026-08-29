# Code signing

DwarfAI-Miners ships **unsigned** today. This is a factual note on what that means, what it
would take to fix, and the exact config to drop in once a certificate exists — no signing
config is staged in `package.json` in the meantime, since an unused, unreachable config block is
worse than a comment.

## What's unsigned today

- **Windows** (`pnpm package`): the NSIS installer and the portable exe are not
  Authenticode-signed. First run triggers Windows SmartScreen ("Windows protected your PC" /
  "Unknown publisher"), and the installer's publisher shows as unverified. The binary still
  runs — the user has to click "More info" → "Run anyway" — but every fresh machine sees the
  warning once.
- **macOS** (`pnpm package:mac`): the `.dmg`/`.zip` are neither signed nor notarized. Gatekeeper
  refuses to open the app from a normal double-click ("Apple could not verify ... is free of
  malware"); the user has to right-click → Open, or clear the quarantine attribute
  (`xattr -d com.apple.quarantine`) manually.
- **Linux** (`pnpm package:linux`): the AppImage and `.deb` are unsigned. Most Linux distros
  don't gate execution on a signature the way Windows/macOS do, so this is the least visible gap
  — but package managers that verify `.deb` signatures (a private apt repo, for instance) would
  still reject it.

None of this is a bug — it is the default state for a project with no signing identity, and this
file exists so that stays a documented, chosen state rather than a silent gap.

## What a certificate costs and requires

### Windows: Authenticode

Two flavors of code-signing certificate apply, both issued by a CA (DigiCert, Sectigo, SSL.com,
etc.):

|                        | OV (Organization Validation)                                                                              | EV (Extended Validation)                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Identity check         | Organization's legal existence and address                                                                | OV checks plus a more rigorous business-vetting process                                             |
| Typical cost           | ~$70–250/year                                                                                             | ~$250–450/year                                                                                      |
| SmartScreen reputation | Builds up over time (new signatures start with little to no reputation, so early releases can still warn) | Effectively immediate — EV certs get instant SmartScreen reputation                                 |
| Key storage            | File-based key (softtoken) commonly allowed                                                               | Must live on a hardware token (USB) or in a cloud HSM — EV keys can't be exported as a plain `.pfx` |

For a low-volume indie tool like this one, OV is the practical starting point; EV mainly buys
immediate SmartScreen trust instead of it accumulating over the first weeks/months of
downloads, at several times the cost and the extra friction of hardware-token signing (which
electron-builder does not automate — a hardware/cloud-HSM signer needs `signtoolOptions` or a
custom sign hook, see below).

### Timestamping

Every Windows signature should include a **timestamp** (an RFC 3161 timestamp server, usually
provided by the same CA) so the signature stays valid after the certificate itself expires — the
OS then trusts "this was signed while the cert was valid," not "this cert is still valid today."
Skipping it means every build silently stops being trusted the day the certificate expires, even
for binaries built years earlier.

### macOS: Apple Developer ID + notarization

- Requires an active Apple Developer Program membership: **$99/year**, tied to an Apple ID.
- Issues a **Developer ID Application** certificate (for the app itself) used to codesign the
  `.app` bundle, plus optionally a **Developer ID Installer** certificate if a `.pkg` installer
  is ever added.
- Signing alone is not enough for a smooth Gatekeeper experience post-2020: the signed build must
  also be **notarized** — uploaded to Apple's notary service, scanned, and stapled with a ticket
  — or Gatekeeper still blocks it on first launch.

## electron-builder config for when a certificate exists

Nothing below is wired into `package.json` yet. When a cert is in hand, add the relevant block.

### Windows — a local `.pfx`/`.p12` file (OV, softtoken)

```json
"win": {
  "certificateFile": "path/to/cert.pfx",
  "certificatePassword": "env:WIN_CSC_KEY_PASSWORD",
  "signingHashAlgorithms": ["sha256"],
  "rfc3161TimeStampServer": "http://timestamp.digicert.com"
}
```

`certificatePassword` should reference an environment variable (electron-builder resolves
`CSC_KEY_PASSWORD`/`WIN_CSC_KEY_PASSWORD` from the environment either way) — the password itself
must never be committed. `signingHashAlgorithms` can usually just be `["sha256"]`; the historical
default of also signing with `sha1` for old Windows 7 systems is no longer worth carrying.

### Windows — a hardware token or cloud HSM (EV, or a modern managed signer)

An EV key on a USB token cannot be handed to electron-builder as a file. Two supported paths:

- **Azure Trusted Signing** (Microsoft's replacement for standalone EV tokens, cert-less):
  ```json
  "win": {
    "azureSignOptions": {
      "publisherName": "Jeronimo Repetto",
      "endpoint": "https://<region>.codesigning.azure.net",
      "certificateProfileName": "<profile>",
      "codeSigningAccountName": "<account>"
    }
  }
  ```
  Credentials come from the environment (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET` or a managed identity) — never hard-code them here.
- **Custom sign hook**, for any other HSM/token workflow electron-builder doesn't cover natively:
  ```json
  "win": {
    "sign": "./scripts/sign-windows.mjs"
  }
  ```
  where that script invokes the token's own signing tool (e.g. `signtool.exe` with a
  hardware-backed CSP) against the file path electron-builder passes it.

### macOS — Developer ID + notarization

```json
"mac": {
  "identity": "Developer ID Application: Jeronimo Repetto (TEAMID1234)",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "notarize": true
}
```

electron-builder notarizes automatically when `notarize: true` (or simply when signing
credentials are present and notarization env vars are set) and the following are exported in the
environment: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (an app-specific password, not the Apple
ID's real password), and `APPLE_TEAM_ID`. `hardenedRuntime: true` is required for notarization to
succeed at all on current macOS.

### Where credentials live

None of the values above — `.pfx` files, passwords, Azure secrets, Apple app-specific passwords —
belong in `package.json` or the repo. They are read from the environment (CI secrets locally, or
a local untracked `.env` for a manual signed build), exactly like every other credential this
project already keeps out of source (see `.env.example`).

## Linux

electron-builder does not sign AppImage/deb output itself. If distribution ever needs it: GPG-sign
the `.deb` (`dpkg-sig` or a signed apt repository) and/or GPG-sign the AppImage
(`appimagetool`'s built-in `--sign`). Neither is planned; noted here for completeness only.
