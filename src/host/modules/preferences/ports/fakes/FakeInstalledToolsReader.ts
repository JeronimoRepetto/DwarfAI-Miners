// The InstalledToolsReader double (16 §4.12; 16 §2.8 `Fake*`): a scripted detection cache, as the
// `host/wiring` bridge reads the suppliers detection. Never imported by production code (R14).
import type { IntegrationId } from '../../../../kernel/domain/values'
import type { InstalledToolsReader } from '../installedToolsReader'

export class FakeInstalledToolsReader implements InstalledToolsReader {
  private tools: IntegrationId[] = []

  installed(): IntegrationId[] {
    return [...this.tools]
  }

  /** What the detection found, for the next `installed()` (a tool installed between boots). */
  script(tools: readonly IntegrationId[]): void {
    this.tools = [...tools]
  }
}
