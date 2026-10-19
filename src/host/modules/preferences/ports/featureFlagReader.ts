// Driven port (05 §3.12, 16 §4.12): the Host's two feature flags, read once at startup from the
// environment, then the userData config file, then the defaults (INV-110). The reader lives in
// `host/wiring`, the one Host place allowed to use the shared parser of `contracts/config` (05 §5.1
// R9), and is passed to `createPreferences`. No seam member sets a flag (US-GUILD-002.AC03).

/** 06 §14.2 `FeatureFlags`: both off by default; each independent of the other (US-GUILD-003.AC03). */
export interface FeatureFlags {
  guildAreasEnabled: boolean
  boostEnabled: boolean
}

export interface FeatureFlagReader {
  read(): FeatureFlags
}
