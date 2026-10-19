// Pure config parser (05 §2.1 `config/`), transplanted by ISSUE-010. The I/O half (process.env, the file on
// disk) stays with its callers: the Host's FeatureFlagReader wiring (ISSUE-211) and UI main.
export * from './config'
export * from './configFile'
