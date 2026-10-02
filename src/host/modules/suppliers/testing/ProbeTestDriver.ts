// A `ProviderDriver` double for the capability probe (17 §2.2): `detect()` goes through the one
// installed detection, as every real driver's does (ADR-009 D5, `detectForDriver`), or answers
// installed by itself for a profile with no CLI (`installDetection: 'none'`); `probe()` runs the
// script the test gives it. It counts every probe and records every launch attempt, so a test can
// prove that probing never starts a session (ADR-009 D4).
import type { ProviderCapabilities } from '../domain/capabilities'
import type { DriverTransport, ProviderProfile } from '../domain/profile'
import { detectForDriver, type InstallDetection } from '../application/detection'
import type {
  DetectResult,
  DriverLaunchError,
  DriverLaunchRequest,
  DriverSession,
  InstalledProvider,
  ProviderDriver
} from '../ports/providerDriver'

/** What one probe does: answer, never answer (a hung CLI), or break the "never throws" rule. */
export type ProbeScript = (
  install: InstalledProvider
) => Promise<ProviderCapabilities> | 'hang' | 'throw'

export interface ProbeTestDriverOptions {
  readonly profile: ProviderProfile
  readonly transport: DriverTransport
  readonly detection: InstallDetection
  readonly probe: ProbeScript
}

export class ProbeTestDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport: DriverTransport
  /** Every install `probe()` was called with, in order. */
  readonly probed: InstalledProvider[] = []
  /** Every launch attempt; probing must never add one. */
  readonly launches: DriverLaunchRequest[] = []
  probeScript: ProbeScript

  constructor(private readonly options: ProbeTestDriverOptions) {
    this.profile = options.profile
    this.transport = options.transport
    this.probeScript = options.probe
  }

  async detect(): Promise<DetectResult> {
    if (this.profile.binaries.length === 0) {
      return {
        kind: 'installed',
        install: {
          providerId: this.profile.id,
          binaryPath: `builtin:${this.profile.id}`,
          version: 'builtin',
          resolvedVia: 'path',
          statMtimeMs: 0
        }
      }
    }
    return detectForDriver(this.options.detection, {
      providerId: this.profile.id,
      binaries: this.profile.binaries
    })
  }

  probe(install: InstalledProvider): Promise<ProviderCapabilities> {
    this.probed.push(structuredClone(install))
    const run = this.probeScript(install)
    if (run === 'hang') return new Promise(() => {})
    if (run === 'throw') return Promise.reject(new Error('probe broke its contract'))
    return run
  }

  async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    this.launches.push(req)
    const refused: DriverLaunchError = { cause: 'could-not-start', detail: 'test double' }
    throw refused
  }
}
