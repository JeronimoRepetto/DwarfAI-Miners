// `protocolVersion` (ADR-003 item 5; ADR-002 D8; 20 §3.1): an integer, private per build, sent in
// `hello` by the UI and in `hello.ok` by the Host. It changes whenever a seam-B method or frame is
// added, changed or removed, and it only tells a same-generation `compat` attach apart: it is never
// a feature gate (14 §1.3; capabilities are). One constant, so both processes of one build agree.
export const PROTOCOL_VERSION = 1
