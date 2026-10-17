// The `opencode-plugin` target of the one config writer (ADR-016 items 5–7; 16 §7.1, §7.5):
// DwarfAI's own plugin file in OpenCode's plugin folder. The engine (`configWriterEngine.ts`) owns
// the file I/O, the backup, the atomic write, the read-back and the ledger; this adapter only reads
// and renders bytes.
//
// Ownership (ADR-016 item 6.2; 16 §7.1): the whole file is DwarfAI's only when its first line is
// exactly `// dwarfai-managed <install-id>` with THIS installation's id. Any other file under
// DwarfAI's name — the person's own, another installation's, an empty one — is foreign: never
// overwritten and never removed. The old app's file (16 §7.1 "Old-app entries", AMENDMENT-7) is
// recognized only by its exact shape (its header line, its loopback URL line and its token line) and
// never reported as DwarfAI's own: `render` replaces it and `removeOwned` deletes it, after the
// engine's backup. It sits at the same path DwarfAI writes, which is why the file keeps the old
// app's name.
//
// Evaluated candidate: the legacy `src/main/opencodePermissions/openCodePluginInstaller.ts` and
// `openCodePluginChannel.ts` (found tree) — replaced. They identify the file by a header that names
// no installation (so one profile's file passes for another's), write it in place through
// `HookFsLike` with no backup, no re-read and no read-back (ADR-016 items 6.3–6.5), record the
// consent as a marker file instead of `config_writes` (item 6.6), and post to the legacy listener
// with the token the Claude hooks share (item 1). Kept: the file name, the rule that a file DwarfAI
// did not write is reported and left exactly as found, and the token and loopback checks before
// anything is rendered.
import type { ChannelToken } from '../../../ports/externalConfigWriter'
import type { ConfigTargetAdapter, OwnershipProbe, RenderScope } from '../configTargetAdapter'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import {
  ownedHeader,
  portOfArtifact,
  renderPluginArtifact,
  tokenOfArtifact
} from './pluginArtifact'

/**
 * The file name inside OpenCode's plugin folder: the old app's, so an install replaces the old
 * app's file in the same write (16 §7.1). `.ts` because OpenCode loads it with no build step.
 */
export const OPENCODE_PLUGIN_FILE_NAME = 'dwarfai-miners-permission.ts'

/** The old app's first line, exactly as it wrote it (legacy `OPENCODE_PLUGIN_HEADER`). */
const OLD_APP_HEADER =
  '// dwarfai-miners:opencode-permission-plugin -- written by DwarfAI-Miners; turn it off in Settings to remove it.'
/** The old app's URL and token lines, with the values its installer accepted. */
const OLD_APP_URL_LINE =
  /^const PUSH_URL = 'http:\/\/127\.0\.0\.1:\d{1,5}\/dwarfai-miners-hook\/opencode'\r?$/m
const OLD_APP_TOKEN_LINE = /^const PUSH_TOKEN = '[0-9a-f]{16,}'\r?$/m

export interface OpenCodePluginConfigWriterOptions {
  /** `<OpenCode's plugin folder>/dwarfai-miners-permission.ts`, absolute (16 §7.1). */
  path: string
  /** `app_meta.install_id` (10 §app_meta): the ownership header's id. */
  installId: string
  /** The persisted ingress port at the moment of the write (ADR-016 item 3; S14.10 rewrites). */
  ingressPort: () => number
}

/** The file's text as read; `null` when it does not exist. */
export interface OpenCodePluginDocument {
  readonly text: string | null
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

/** The file's first line, without its line ending. */
const firstLineOf = (text: string): string => text.split('\n', 1)[0]?.replace(/\r$/, '') ?? ''

export class OpenCodePluginConfigWriter implements ConfigTargetAdapter<OpenCodePluginDocument> {
  readonly target = 'opencode-plugin' as const
  readonly path: string
  readonly ownedMarker: string

  constructor(private readonly options: OpenCodePluginConfigWriterOptions) {
    this.path = options.path
    // Checks the install id once: a header that is not one exact line could never be probed.
    this.ownedMarker = ownedHeader(options.installId)
  }

  /**
   * Never `malformed`: the whole file is either DwarfAI's (or the old app's) and replaced, or
   * foreign and never touched, so no content of it is ever parsed or kept.
   */
  read(bytes: Uint8Array | null): { ok: true; value: OpenCodePluginDocument } {
    return { ok: true, value: { text: bytes === null ? null : decoder.decode(bytes) } }
  }

  probeOwned(doc: OpenCodePluginDocument): OwnershipProbe {
    if (doc.text === null) return 'absent'
    if (firstLineOf(doc.text) === this.ownedMarker) return 'owned'
    // The old app's file holds the slot DwarfAI replaces (16 §7.1); it is not DwarfAI's own.
    if (this.isOldAppFile(doc.text)) return 'absent'
    return 'foreign'
  }

  probeLegacy(doc: OpenCodePluginDocument): boolean {
    return doc.text !== null && this.isOldAppFile(doc.text)
  }

  render(
    doc: OpenCodePluginDocument,
    token: ChannelToken,
    scope: RenderScope = 'with-old-app'
  ): Uint8Array {
    // The whole file is the entry: a rewrite that must keep the old app's file cannot write here.
    // The engine renders `owned-only` only over DwarfAI's own file (07 S14.10).
    if (scope === 'owned-only' && doc.text !== null && this.isOldAppFile(doc.text)) {
      throw new HostInvariantError('opencode-plugin: an owned-only rewrite over the old app file')
    }
    return encoder.encode(
      renderPluginArtifact({
        installId: this.options.installId,
        port: this.options.ingressPort(),
        token
      })
    )
  }

  /** 07 S14.10: DwarfAI's own file reports to the persisted ingress port. */
  isCurrent(doc: OpenCodePluginDocument): boolean {
    return doc.text === null || portOfArtifact(doc.text) === this.options.ingressPort()
  }

  /** 07 S14.11: the token DwarfAI's own file carries, for the engine's active-token check. */
  ownedTokens(doc: OpenCodePluginDocument): readonly string[] {
    const token = doc.text === null ? null : tokenOfArtifact(doc.text)
    return token === null ? [] : [token]
  }

  /** The file is DwarfAI's (or the old app's) alone: it is deleted; the folder stays. */
  removeOwned(_doc: OpenCodePluginDocument): Uint8Array | null {
    return null
  }

  private isOldAppFile(text: string): boolean {
    return (
      firstLineOf(text) === OLD_APP_HEADER &&
      OLD_APP_URL_LINE.test(text) &&
      OLD_APP_TOKEN_LINE.test(text)
    )
  }
}
