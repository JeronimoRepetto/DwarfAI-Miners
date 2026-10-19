// Pure ADR-026 logging rules, no I/O (05 §2.1 `logging/`, §3.13). The canary corpus under `testing/`
// is test-only and deliberately not exported (R14).
export {
  LOG_CAP_BYTES,
  LOG_RECORD_FIELDS,
  LOG_SEGMENT_BYTES,
  PRUNE_EVERY_BYTES,
  logRecordSchema,
  type LogLevel,
  type LogProc,
  type LogRecord
} from './logRecord'
export { REDACTED, redactSecrets } from './redactSecrets'
export {
  LOG_STACK_MAX_CHARS,
  LOG_STACK_MAX_FRAMES,
  LOG_TEXT_MAX_CHARS,
  redactStack,
  redactText,
  reduceThirdPartyError
} from './redact'
export { toLogLine, type LogLineRefusal } from './toLogLine'
export { nextSeq, parseSegmentName, segmentName, type SegmentPrefix } from './segments'
export { planPrune, type SegmentInfo } from './planPrune'
