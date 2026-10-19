// The `IntegrationGateReader` double (16 §4.4): each integration's state as the test sets it. An
// integration the test never set reads `off`, the new-install default (ADR-011 item 7).
import type { IntegrationId, IntegrationState } from '../../../../kernel/domain/values'
import type { IntegrationGateReader } from '../integrationGateReader'

export class FakeIntegrationGateReader implements IntegrationGateReader {
  private readonly states = new Map<IntegrationId, IntegrationState>()

  set(id: IntegrationId, state: IntegrationState): void {
    this.states.set(id, state)
  }

  state(id: IntegrationId): IntegrationState {
    return this.states.get(id) ?? 'off'
  }
}
