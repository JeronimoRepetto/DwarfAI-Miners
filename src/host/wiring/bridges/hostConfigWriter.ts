// The Host's one config writer as host/main.ts composes it for cut 2 (16 §7.1, ADR-016 items 3, 6;
// 21 §1 item 4, §2 cut 2), per target:
//
// - `claude-hooks` → the config writer engine (configWriterEngine.ts) with the Claude Code hooks
//   adapter, which host/main.ts constructs over the Host database. The hook entry points at the
//   hook ingress's stable port (ADR-016 item 3: chosen when the first HTTP integration is enabled,
//   persisted in `app_meta.ingress_port`). That port is chosen and persisted by the ingress itself,
//   which boot step 6 starts (later: ISSUE-140, ISSUE-209). Until a port is persisted an enable
//   fails closed here, before the engine's Tx A: nothing is written, no `config_writes` row and no
//   token hash is issued, the integration stays `off`, and the command answers
//   `config-write-failed` (16 §7.3 Tx B failure, the same outcome). An entry pointing at a port
//   nothing listens on would be an integration that is never on in fact. Turning it off, the boot
//   re-verification and the legacy probe need no port and always reach the engine.
// - `opencode-plugin` → nothing: in cuts 2 to 3e the OpenCode plugin file's writer is still the
//   legacy installer (21 §2 cut 2; offeredFilter.ts), and a foreign config entry has exactly one
//   writer per release (21 §1 item 4). This Host never writes it, so it owns no entry there: `verify`
//   answers `absent`, `revert` completes with nothing to remove (the Reset saga's `external-config`
//   step, 16 §7.4), `findLegacy` is never true (S41.02 runs on offered targets only), and `install`
//   is refused. The OpenCode target joins the engine with its writer (later: ISSUE-227, ISSUE-232).
//
// Neither the token nor its hash reaches a log record (NFR-SEC-12, ADR-026).
import { HostInvariantError } from '../../kernel/domain/errors'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { ExternalConfigWriter } from '../../modules/preferences'
import type { IngressPortRecord } from '../../transport/ingress/ingressPort'

export interface HostConfigWriterDeps {
  /** The config writer engine with the `claude-hooks` target (host/main.ts). */
  claudeHooks: ExternalConfigWriter
  /** `app_meta.ingress_port` as the hook ingress persisted it (bridges/ingressPort.ts). */
  ingressPort: Pick<IngressPortRecord, 'read'>
  log: DiagnosticsLog
}

/** The `ExternalConfigWriter` the preferences module, its first-run step and its Reset saga use. */
export function hostConfigWriter(deps: HostConfigWriterDeps): ExternalConfigWriter {
  const { claudeHooks } = deps
  return {
    install: (target, token, origin, tokenSha256) => {
      if (target !== 'claude-hooks') return Promise.resolve({ ok: false, error: 'io' })
      if (deps.ingressPort.read() === null) {
        deps.log.record({
          level: 'warn',
          event: 'config.write',
          subsystem: target,
          outcome: 'failed',
          msg: origin,
          causeClass: 'ingress-port-unset'
        })
        return Promise.resolve({ ok: false, error: 'io' })
      }
      return claudeHooks.install(target, token, origin, tokenSha256)
    },
    verify: (target) =>
      target === 'claude-hooks' ? claudeHooks.verify(target) : Promise.resolve('absent'),
    revert: (target) =>
      target === 'claude-hooks'
        ? claudeHooks.revert(target)
        : Promise.resolve({ ok: true, value: undefined }),
    findLegacy: (target) =>
      target === 'claude-hooks' ? claudeHooks.findLegacy(target) : Promise.resolve(false)
  }
}

/**
 * The Claude Code hooks adapter's `ingressPort` (ClaudeHooksConfigWriter): the persisted port at
 * the moment of the write. `hostConfigWriter` never lets an enable reach the engine without one, so
 * a missing port here is a wiring defect.
 */
export function persistedIngressPort(record: Pick<IngressPortRecord, 'read'>): () => number {
  return () => {
    const port = record.read()
    if (port === null) {
      throw new HostInvariantError('a Claude hook entry is rendered only with a persisted port')
    }
    return port
  }
}
