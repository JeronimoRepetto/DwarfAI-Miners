# Code signing

**No build is signed today.** The macOS config below (`build.mac` in `package.json`) is still wired
for a Developer ID signature and notarization, but since ISSUE-268 no CI job holds the credentials:
the `package` job of `.github/workflows/ci.yml` (on a `v*` tag or a manual dispatch) and the
internal build of `.github/workflows/internal-build.yml` both package macOS unsigned, and neither
publishes anything. The signed, notarized macOS release returns with ISSUE-280, and the upload to a
GitHub Release with ISSUE-278; no public build exists before cut 5 (OQ-66). Windows and Linux stay
unsigned. This is a factual note on what that means for each platform, what each would take to
sign, and the macOS config that is already in `package.json`.

## What's signed today

- **macOS** (`pnpm build && pnpm package` on a Mac): unsigned. The CI jobs pass
  `-c.mac.identity=null` and `CSC_IDENTITY_AUTO_DISCOVERY=false`, so electron-builder signs
  nothing and skips notarization with it. On first launch macOS refuses the app until it is opened
  once through System Settings > Privacy & Security > "Open Anyway". A local run with a Developer
  ID certificate in the keychain and the Apple variables set would sign and notarize, through the
  config below.
- **Windows** (`pnpm build && pnpm package` on Windows): the Scoop zip and the per-user NSIS
  installer are not Authenticode-signed. First run triggers Windows SmartScreen ("Windows protected
  your PC" / "Unknown publisher"), and the installer's publisher shows as unverified. The binary
  still runs — the user has to click "More info" → "Run anyway" — but every fresh machine sees the
  warning once.
- **Linux** (`pnpm build && pnpm package` on Linux): the AppImage and `.deb` are unsigned. Most
  Linux distros don't gate execution on a signature the way Windows/macOS do, so this is the least
  visible gap — but package managers that verify `.deb` signatures (a private apt repo, for
  instance) would still reject it.

Windows/Linux staying unsigned is not a bug — it is the default state for a project with no
Windows/Linux signing identity, and the sections below on those two platforms are still the
config to drop in if that ever changes, not something wired into `package.json` yet.

## macOS builds from before this change

Any `.dmg`/`.zip` built before the first signed release still opens only via right-click → Open,
or by clearing the quarantine attribute:

```bash
xattr -cr "/Applications/DwarfAI-Miners.app"
```

That remedy is unchanged and still correct for those older builds; it is not needed for a release
built after this change.

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

## electron-builder config

The Windows and Linux blocks below are still **not** wired into `package.json` — add the relevant
one when a cert is in hand. The macOS block **is** wired in (`build.mac` in `package.json`); its
subsection below shows the actual config rather than a proposal.

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

### macOS — Developer ID + notarization (wired in)

```json
"mac": {
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist",
  "notarize": true
}
```

electron-builder 26.15.3 predates the v27 config restructuring that moves these keys under a
nested `mac.sign` object, so on this version they stay top-level under `mac` exactly as above.

No `identity` string is set. electron-builder's own default for an unset `mac.sign`/identity is
to "auto-discover a valid certificate in the keychain. If none is found, signing is skipped" —
`CSC_LINK` (the Developer ID Application `.p12`, base64-encoded) is what CI decodes into a
temporary keychain for it to find; there is nothing to hardcode.

`hardenedRuntime: true` is required for notarization to succeed at all on current macOS, and in
turn requires entitlements — electron-builder's own docs call entitlements "mandatory when
utilizing Hardened Runtime and for the notarization process" for an Electron app. The two keys in
[`build/entitlements.mac.plist`](../build/entitlements.mac.plist) — `com.apple.security.cs.allow-jit`
and `com.apple.security.cs.allow-unsigned-executable-memory` — are exactly electron-builder's
documented minimum for an Electron app under Hardened Runtime, nothing project-specific added.
The same file is referenced from both `entitlements` and `entitlementsInherit` so the app and its
helper processes carry the same minimal grant.

`gatekeeperAssess: false` skips electron-builder's own post-sign `spctl --assess` sanity check.
Left at its default (`true`) it would evaluate the app's Gatekeeper acceptance immediately after
signing — before notarization has stapled a ticket to it — which fails for exactly the reason
this whole change exists (an unstapled, freshly-signed app isn't yet what Gatekeeper accepts). The
real acceptance check is `spctl -a -vv` against the finished, notarized artifact — see the
verification checklist below — not this build-time assessment.

`notarize: true` stays a plain boolean rather than an explicit credentials object: electron-builder
reads `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` from the environment for it.
See "Local packaging without a certificate" for what this means when those variables, or
`CSC_LINK`, are absent.

### Local packaging without a certificate

`pnpm package` on a Mac must keep working with no Apple credentials at all — for a contributor without
a certificate, and on a Windows/Linux dev machine where the mac target is never actually invoked
for real. Nothing in `pnpm package` itself changed to guarantee that; it relies on two of
electron-builder's own documented defaults, both already covered above:

- No `CSC_LINK` and no matching identity in the local keychain → **signing is skipped, not
  failed** (electron-builder's own troubleshooting docs: "If the build produces unsigned output
  without error, it is likely because the `CSC_LINK` environment variable is not set"). The build
  still completes; the app comes out unsigned, or ad-hoc-signed if the host machine's own keychain
  happens to offer an ad-hoc identity.
- `notarize: true` only has a signed build to submit once signing actually produced one with a
  Developer ID identity. Without `CSC_LINK`, there is nothing to hand to Apple's notary service.
  And the flag itself does not fail a build that lacks credentials: read in the installed
  `app-builder-lib` 26.15.3 (`out/mac/MacTargetHelper.js`, `notarizeIfProvided`), with none of
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` set it logs
  `skipped macOS notarization` (reason: "`notarize` options were unable to be generated") and
  carries on. It throws only when SOME of the three are set and the others are missing, which is
  the one misconfiguration worth failing loudly on.

The alternative design was a CI-only flag threaded through `pnpm package` (e.g. a `--publish`-style
switch, or a second script) that only enables `notarize`/signing when the workflow passes it. That
was rejected: it would duplicate the target list `build.mac` already owns as the single source
of truth for what gets built (the package script and the workflow are
already coupled through artifact-name globs; a flag adds a second axis of coupling for no
behavioral gain over what electron-builder already does by itself). The tradeoff is that this
leans on electron-builder's internal env-gating rather than an explicit switch this repo controls
— see the verification checklist for what a real Mac run still has to confirm about it.

## Where the credentials live

**macOS.** The GitHub **`release` environment** holds the five secrets a signed macOS build needs,
and nothing else:

- `CSC_LINK` — the Developer ID Application certificate (`.p12`), base64-encoded
- `CSC_KEY_PASSWORD` — that certificate's export password
- `APPLE_ID` — the Apple ID used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD` — an app-specific password for that Apple ID (not its real
  password)
- `APPLE_TEAM_ID` — the Developer Team ID

No job uses that environment since ISSUE-268 replaced the `release-mac` job with the unsigned
`package` job. The signed macOS release job (ISSUE-280) attaches it again, exporting the secrets
as `env` on its packaging step only; the environment's `v*` tag deployment rule then keeps that
job from running for any ref that isn't a `v*` tag, independent of the job's own `if:`.

**Windows/Linux (when wired in).** None of the values in the sections above — `.pfx` files,
passwords, Azure secrets — belong in `package.json` or the repo either. They would be read from
the environment (CI secrets, or a local untracked `.env` for a manual signed build), exactly like
every other credential this project already keeps out of source (see `.env.example`).

## Verification checklist for the signed macOS release (ISSUE-280)

None of this runs today; it is what the signed release job has to prove once it exists, and a
maintainer with a Mac should separately confirm the local case:

- [ ] Its "Package" step actually signs: the log shows a Developer ID Application identity found
      (not "identity not found" / ad-hoc), and notarization submitted and accepted rather than
      skipped.
- [ ] The `.dmg`/`.zip` file names are unchanged (`${productName}-${version}-${arch}.${ext}`, no
      `-mac` suffix).
- [ ] On a fresh Mac that never had the app: download the arm64 `.dmg`, double-click, it opens
      with no Gatekeeper warning; `spctl -a -vv "/Applications/DwarfAI-Miners.app"` reports
      `accepted` / `source=Notarized Developer ID`.
- [ ] Separately, on a Mac with no Apple secrets in the environment: `pnpm build && pnpm package`
      still completes and produces an (unsigned or ad-hoc) `.dmg`/`.zip` rather than failing —
      confirming the "Local packaging without a certificate" behavior above actually holds.

## Linux

electron-builder does not sign AppImage/deb output itself. If distribution ever needs it: GPG-sign
the `.deb` (`dpkg-sig` or a signed apt repository) and/or GPG-sign the AppImage
(`appimagetool`'s built-in `--sign`). Neither is planned; noted here for completeness only.
