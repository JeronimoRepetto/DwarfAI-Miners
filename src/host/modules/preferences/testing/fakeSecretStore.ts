// The `FakeSecretStore` double (16 §4.12.1) for the suites outside the module (host/transport,
// host/wiring), which reach the module only through its index.ts or testing/ (05 §5.1 R15). Never
// imported by production code (R14).
export { FakeSecretStore } from '../ports/fakes/FakeSecretStore'
