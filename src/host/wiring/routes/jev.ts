// The jev module's transport route (05 §4; 16 §8.2, §8.3):
//
// - `serveJev`, run by the composition root before the boot binds the endpoint, so every `hello.ok`
//   lists B-M38 `jev.suggest` (14 §1.3). Until boot step 4 bound the module the Host is not `ready`,
//   so a call answers HOST_NOT_READY before reaching it; a call that still did would be a wiring
//   defect.
// - `bind`, run by boot step 4 right after suppliers is wired: constructs the jev module over the
//   adapters and bridges the composition root hands it (`TypesafeJevRouter`, the kernel
//   `SecretReader`, the `RoutingCatalogSource` bridge to `suppliers.launchable()`, the preferences
//   queries) and serves B-M38 over its advisor. It returns the module, whose `advisor` is the
//   `JevAdvisor` the launching `LaunchAdvisor` bridge reads (later: ISSUE-182).
import { HostInvariantError } from '../../kernel/domain/errors'
import { createJev, type AbortableJevAdvisor, type Jev, type JevDeps } from '../../modules/jev'
import type { Dispatcher } from '../../transport/dispatcher'
import { registerJevSuggest } from '../../transport/methods/jevSuggest'

export interface JevServeDeps {
  dispatcher: Dispatcher
}

export interface ServedJev {
  /** Constructs the jev module and binds B-M38 to it (boot step 4); once. */
  bind(deps: JevDeps): Jev
}

export function serveJev(serve: JevServeDeps): ServedJev {
  let bound: AbortableJevAdvisor | undefined
  const current = (): AbortableJevAdvisor => {
    if (bound === undefined) throw new HostInvariantError('jev is served from boot step 4 on')
    return bound
  }
  registerJevSuggest(serve.dispatcher, {
    advisor: { suggest: (req, opts) => current().suggest(req, opts) }
  })
  return {
    bind: (deps) => {
      if (bound !== undefined) throw new HostInvariantError('jev is bound once')
      const jev = createJev(deps)
      bound = jev.advisor
      return jev
    }
  }
}
